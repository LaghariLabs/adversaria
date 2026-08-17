#!/usr/bin/env bash
#
# Post-publish verifier for Adversaria releases. Re-fetches the LIVE manifest
# and artifacts from GitHub (never trusts local build output for what shipped)
# and can genuinely FAIL: wrong version, corrupted/re-uploaded bytes, a
# signature that doesn't verify, or a channel that's unreachable. This exists
# because 0.3.74 shipped as a draft while every gate stayed green — see
# docs/TODO.md's publish-release.sh entry.
#
# Checks (each independently PASS / FAIL / SKIPPED / WARN):
#   1. Both channel manifests reachable over HTTP (beta required, stable is a
#      warning only — it has never been published).
#   2. The requested channel's live manifest version == the expected tag.
#   3. Per platform in that manifest: download the artifact fresh and hash it.
#   4. That hash matches the provenance file's recorded hash for that file.
#   5. The manifest's minisign signature over that artifact verifies against
#      the pinned updater pubkey (src-tauri/tauri.conf.json).
#
# Usage:
#   ./scripts/verify-published.sh [TAG] [CHANNEL] [--quick]
#                                  [--allow-no-provenance] [--allow-unverified-sig]
#
#   TAG      defaults to v<version from src-tauri/tauri.conf.json>
#   CHANNEL  defaults to $ADVERSARIA_RELEASE_CHANNEL or "beta"
#   --quick                 skip downloading artifacts (hash/provenance/signature
#                            checks are marked SKIPPED, never PASS — for fast
#                            iteration on the manifest/version checks only)
#   --allow-no-provenance   a platform with no provenance entry is SKIPPED
#                            instead of FAIL (default: FAIL — it means we can't
#                            prove the live bytes are what we built)
#   --allow-unverified-sig  no minisign-capable tooling found is SKIPPED
#                            instead of FAIL
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_REPO="${ADVERSARIA_RELEASE_REPO:-LaghariLabs/adversaria-releases}"

VERSION_TAG=""
CHANNEL=""
QUICK=0
ALLOW_NO_PROVENANCE=0
ALLOW_UNVERIFIED_SIG=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --allow-no-provenance) ALLOW_NO_PROVENANCE=1 ;;
    --allow-unverified-sig) ALLOW_UNVERIFIED_SIG=1 ;;
    -*)
      echo "ERROR: unknown flag $arg"
      exit 1
      ;;
    *)
      if [ -z "$VERSION_TAG" ]; then
        VERSION_TAG="$arg"
      elif [ -z "$CHANNEL" ]; then
        CHANNEL="$arg"
      else
        echo "ERROR: unexpected argument $arg"
        exit 1
      fi
      ;;
  esac
done

if [ -z "$VERSION_TAG" ]; then
  VERSION_TAG="v$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
fi
EXPECTED_VERSION="${VERSION_TAG#v}"
CHANNEL="${CHANNEL:-${ADVERSARIA_RELEASE_CHANNEL:-beta}}"
case "$CHANNEL" in
  beta|stable) ;;
  *) echo "ERROR: channel must be beta or stable, got '$CHANNEL'"; exit 1 ;;
esac

echo "==> Verifying $VERSION_TAG (channel $CHANNEL) against $RELEASE_REPO"
[ "$QUICK" = "1" ] && echo "    --quick: artifact downloads (hash/provenance/signature) will be SKIPPED"

PINNED_PUBKEY="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'])")"
if [ -z "$PINNED_PUBKEY" ]; then
  echo "ERROR: No pinned updater pubkey in tauri.conf.json"
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# The pubkey field (and, below, each manifest's "signature" field) is base64 of
# the actual minisign file text — that's what tauri-plugin-updater's
# verify_signature()/base64_to_string() does before calling PublicKey/Signature
# ::decode. Decode it once up front.
PUBKEY_FILE="$WORKDIR/pubkey.txt"
python3 -c "
import base64, sys
open(sys.argv[2], 'w').write(base64.b64decode(sys.argv[1]).decode())
" "$PINNED_PUBKEY" "$PUBKEY_FILE"

# ---- result table -----------------------------------------------------
RESULTS=()
ANY_FAIL=0
record() {
  RESULTS+=("$1|$2|$3")
  [ "$2" = "FAIL" ] && ANY_FAIL=1
  return 0
}

# ---- manifest fetch, cached per channel so we never fetch the same file twice
manifest_file() { echo "$WORKDIR/manifest-$1.json"; }

ensure_manifest_fetched() {
  local channel="$1"
  [ -f "$WORKDIR/manifest-${channel}.attempted" ] && return 0
  touch "$WORKDIR/manifest-${channel}.attempted"
  local url="https://github.com/$RELEASE_REPO/releases/latest/download/latest-${channel}.json"
  if curl -fsSL "$url" -o "$(manifest_file "$channel")" 2>"$WORKDIR/manifest-${channel}.err"; then
    echo "OK" > "$WORKDIR/manifest-${channel}.status"
  else
    echo "FAIL" > "$WORKDIR/manifest-${channel}.status"
    rm -f "$(manifest_file "$channel")"
  fi
  return 0
}
manifest_ok() {
  [ -f "$WORKDIR/manifest-$1.status" ] && [ "$(cat "$WORKDIR/manifest-$1.status")" = "OK" ]
}

echo "==> [1/4] Probing both channel manifests over HTTP (beta required, stable is a warning)…"
ensure_manifest_fetched "beta"
if manifest_ok "beta"; then
  record "channel-manifest:beta" "PASS" "latest-beta.json reachable"
else
  record "channel-manifest:beta" "FAIL" "latest-beta.json NOT reachable at .../releases/latest/download/latest-beta.json"
fi

ensure_manifest_fetched "stable"
if manifest_ok "stable"; then
  record "channel-manifest:stable" "PASS" "latest-stable.json reachable"
else
  record "channel-manifest:stable" "WARN" "latest-stable.json not reachable — stable has never been published, not a failure"
fi

echo "==> [2/4] Verifying $CHANNEL manifest version == ${EXPECTED_VERSION}…"
ensure_manifest_fetched "$CHANNEL"
MANIFEST=""
if manifest_ok "$CHANNEL"; then
  MANIFEST="$(manifest_file "$CHANNEL")"
  LIVE_VERSION="$(python3 -c "import json;print(json.load(open('$MANIFEST')).get('version',''))" 2>/dev/null)" || LIVE_VERSION=""
  if [ -n "$LIVE_VERSION" ] && [ "$LIVE_VERSION" = "$EXPECTED_VERSION" ]; then
    record "manifest-version:$CHANNEL" "PASS" "live version=$LIVE_VERSION matches expected $EXPECTED_VERSION"
  else
    record "manifest-version:$CHANNEL" "FAIL" "live version='$LIVE_VERSION' != expected '$EXPECTED_VERSION'"
  fi
else
  record "manifest-version:$CHANNEL" "FAIL" "could not fetch latest-${CHANNEL}.json — cannot verify version"
fi

# ---- signature tooling discovery (only if we'll actually download artifacts)
MINISIG_VERIFIER=""
MINISIG_TOOL_NAME=""

setup_minisig_verifier() {
  if command -v minisign >/dev/null 2>&1; then
    MINISIG_VERIFIER="minisign"
    MINISIG_TOOL_NAME="minisign CLI"
    echo "    signature tooling: found 'minisign' CLI."
    return 0
  fi
  if command -v rsign >/dev/null 2>&1; then
    MINISIG_VERIFIER="rsign"
    MINISIG_TOOL_NAME="rsign CLI"
    echo "    signature tooling: found 'rsign' CLI."
    return 0
  fi
  if command -v npx >/dev/null 2>&1 \
    && npx --no-install tauri signer --help 2>&1 | grep -qi '^  *verify'; then
    MINISIG_VERIFIER="tauri-signer"
    MINISIG_TOOL_NAME="npx tauri signer verify"
    echo "    signature tooling: 'npx tauri signer' has a verify subcommand."
    return 0
  fi
  echo "    signature tooling: no minisign/rsign binary, and 'npx tauri signer' has no verify subcommand (sign/generate only)."
  # Fall back to the same zero-dependency crate tauri-plugin-updater itself
  # uses to verify (minisign-verify, pinned in src-tauri/Cargo.lock) — compile
  # a tiny standalone verifier against it. This is genuine Ed25519(ph)
  # minisign verification, not a format check.
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "    signature tooling: compiling minisign-verify (Rust crate) locally…"
    local proj="$WORKDIR/minisig-verifier"
    mkdir -p "$proj/src"
    cat > "$proj/Cargo.toml" <<'EOF'
[package]
name = "minisig-verifier"
version = "0.1.0"
edition = "2021"

[dependencies]
minisign-verify = "=0.2.5"
EOF
    cat > "$proj/src/main.rs" <<'RUST_EOF'
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: minisig-verifier <pubkey-file> <sig-file> <artifact-file>");
        process::exit(2);
    }
    let pubkey_text = match fs::read_to_string(&args[1]) {
        Ok(s) => s,
        Err(e) => { eprintln!("cannot read pubkey file: {e}"); process::exit(2); }
    };
    let sig_text = match fs::read_to_string(&args[2]) {
        Ok(s) => s,
        Err(e) => { eprintln!("cannot read signature file: {e}"); process::exit(2); }
    };
    let artifact = match fs::read(&args[3]) {
        Ok(b) => b,
        Err(e) => { eprintln!("cannot read artifact file: {e}"); process::exit(2); }
    };
    let public_key = match PublicKey::decode(pubkey_text.trim()) {
        Ok(k) => k,
        Err(e) => { eprintln!("bad public key: {e}"); process::exit(2); }
    };
    let signature = match Signature::decode(sig_text.trim()) {
        Ok(s) => s,
        Err(e) => { eprintln!("bad signature: {e}"); process::exit(2); }
    };
    // tauri-plugin-updater's verify_signature() calls public_key.verify(data, &signature, true)
    // — prehashed mode. Match it exactly or a genuinely valid signature will fail to verify.
    match public_key.verify(&artifact, &signature, true) {
        Ok(()) => process::exit(0),
        Err(e) => { eprintln!("signature does not verify: {e}"); process::exit(1); }
    }
}
RUST_EOF
    if (cd "$proj" && cargo build --offline --quiet) 2>"$WORKDIR/cargo-build.err"; then
      MINISIG_VERIFIER="$proj/target/debug/minisig-verifier"
      MINISIG_TOOL_NAME="minisign-verify crate (compiled locally, offline)"
      echo "    signature tooling: compiled OK."
    else
      echo "    signature tooling: failed to compile minisign-verify crate:"
      sed 's/^/      /' "$WORKDIR/cargo-build.err" | tail -20
    fi
  fi
  return 0
}

verify_signature_for() {
  local pubkey_file="$1" sig_file="$2" artifact_file="$3"
  case "$MINISIG_VERIFIER" in
    minisign)
      minisign -V -p "$pubkey_file" -m "$artifact_file" -x "$sig_file" -q >/dev/null 2>&1
      ;;
    rsign)
      rsign verify -p "$pubkey_file" -x "$sig_file" "$artifact_file" >/dev/null 2>&1
      ;;
    tauri-signer)
      npx --no-install tauri signer verify -p "$pubkey_file" -s "$sig_file" "$artifact_file" >/dev/null 2>&1
      ;;
    "")
      return 1
      ;;
    *)
      "$MINISIG_VERIFIER" "$pubkey_file" "$sig_file" "$artifact_file" >/dev/null 2>&1
      ;;
  esac
}

echo "==> [3/4] Checking artifacts for each platform in the $CHANNEL manifest…"

PROVENANCE_PATH="src-tauri/target/release/bundle/provenance-${CHANNEL}.json"
PROVENANCE_OK=0
PROVENANCE_REASON=""
if [ -f "$PROVENANCE_PATH" ]; then
  PROV_VERSION="$(python3 -c "import json;print(json.load(open('$PROVENANCE_PATH')).get('app',{}).get('version',''))" 2>/dev/null)" || PROV_VERSION=""
  if [ "$PROV_VERSION" = "$EXPECTED_VERSION" ]; then
    PROVENANCE_OK=1
  else
    PROVENANCE_REASON="provenance app.version='$PROV_VERSION' != expected '$EXPECTED_VERSION' (stale/mismatched local build) at $PROVENANCE_PATH"
  fi
else
  PROVENANCE_REASON="no provenance file at $PROVENANCE_PATH (only produced by scripts/build-dmg.sh — macOS builds)"
fi

PLATFORMS_LIST="$WORKDIR/platforms.tsv"
: > "$PLATFORMS_LIST"
if [ -n "$MANIFEST" ]; then
  python3 - "$MANIFEST" "$WORKDIR" > "$PLATFORMS_LIST" <<'PY'
import json, sys, base64, os
manifest_path, workdir = sys.argv[1], sys.argv[2]
data = json.load(open(manifest_path))
for platform, info in sorted(data.get("platforms", {}).items()):
    url = info.get("url", "")
    sig_field = info.get("signature", "")
    if not url or not sig_field:
        print(f"{platform}\t\t")
        continue
    sig_plain_path = os.path.join(workdir, f"sig-{platform}.txt")
    try:
        decoded = base64.b64decode(sig_field).decode()
    except Exception:
        decoded = ""
    with open(sig_plain_path, "w") as f:
        f.write(decoded)
    print(f"{platform}\t{url}\t{sig_plain_path}")
PY
else
  record "platforms" "SKIPPED" "no live $CHANNEL manifest — cannot enumerate platforms to check"
fi

if [ -s "$PLATFORMS_LIST" ] && [ "$QUICK" != "1" ]; then
  setup_minisig_verifier
fi

while IFS=$'\t' read -r PLATFORM URL SIGFILE; do
  [ -z "$PLATFORM" ] && continue

  if [ -z "$URL" ]; then
    record "download:$PLATFORM" "FAIL" "manifest entry for $PLATFORM is missing url or signature"
    record "provenance:$PLATFORM" "SKIPPED" "no url"
    record "signature:$PLATFORM" "SKIPPED" "no url"
    continue
  fi

  if [ "$QUICK" = "1" ]; then
    record "download:$PLATFORM" "SKIPPED(--quick)" "artifact not downloaded"
    record "provenance:$PLATFORM" "SKIPPED(--quick)" "no downloaded artifact to hash"
    record "signature:$PLATFORM" "SKIPPED(--quick)" "no downloaded artifact to verify"
    continue
  fi

  BASENAME="$(basename "$URL")"
  ARTIFACT_FILE="$WORKDIR/artifact-${PLATFORM}"
  echo "    downloading $PLATFORM ($BASENAME)…"
  # Retries are safe HERE because the sha256 diff below is what proves the
  # bytes — a resumed flaky transfer that hashes right is still proof. This
  # machine's network demonstrably resets long GitHub transfers (it broke the
  # 0.3.74 publish and failed this script's own first live run, 2026-08-08).
  if curl -fSL --retry 4 --retry-delay 2 --retry-all-errors --silent --show-error \
      "$URL" -o "$ARTIFACT_FILE"; then
    SHA="$(shasum -a 256 "$ARTIFACT_FILE" | awk '{print $1}')" || SHA=""
    if [ -n "$SHA" ]; then
      record "download:$PLATFORM" "PASS" "$BASENAME downloaded, sha256=$SHA"
    else
      record "download:$PLATFORM" "FAIL" "downloaded $BASENAME but could not compute sha256"
      record "provenance:$PLATFORM" "SKIPPED" "no hash"
      record "signature:$PLATFORM" "SKIPPED" "no hash"
      continue
    fi
  else
    record "download:$PLATFORM" "FAIL" "could not download $URL"
    record "provenance:$PLATFORM" "SKIPPED" "download failed"
    record "signature:$PLATFORM" "SKIPPED" "download failed"
    continue
  fi

  # ---- provenance diff --------------------------------------------------
  if [ "$PROVENANCE_OK" = "1" ]; then
    EXPECTED_SHA="$(python3 - "$PROVENANCE_PATH" "$BASENAME" <<'PY' 2>/dev/null
import json, sys
data = json.load(open(sys.argv[1]))
target = sys.argv[2]
for e in data.get("distribution_artifacts", []):
    if e.get("filename") == target:
        print(e.get("sha256", ""))
        break
PY
)" || EXPECTED_SHA=""
    if [ -z "$EXPECTED_SHA" ]; then
      if [ "$ALLOW_NO_PROVENANCE" = "1" ]; then
        record "provenance:$PLATFORM" "SKIPPED(--allow-no-provenance)" "no provenance entry for $BASENAME in $PROVENANCE_PATH"
      else
        record "provenance:$PLATFORM" "FAIL" "no provenance entry for $BASENAME in $PROVENANCE_PATH"
      fi
    elif [ "$EXPECTED_SHA" = "$SHA" ]; then
      record "provenance:$PLATFORM" "PASS" "sha256 matches provenance ($SHA)"
    else
      record "provenance:$PLATFORM" "FAIL" "sha256 MISMATCH for $BASENAME: live=$SHA provenance=$EXPECTED_SHA"
    fi
  else
    if [ "$ALLOW_NO_PROVENANCE" = "1" ]; then
      record "provenance:$PLATFORM" "SKIPPED(--allow-no-provenance)" "$PROVENANCE_REASON"
    else
      record "provenance:$PLATFORM" "FAIL" "$PROVENANCE_REASON"
    fi
  fi

  # ---- signature ----------------------------------------------------------
  if [ -z "$SIGFILE" ] || [ ! -s "$SIGFILE" ]; then
    record "signature:$PLATFORM" "FAIL" "manifest entry for $PLATFORM has no usable signature"
  elif [ -z "$MINISIG_VERIFIER" ]; then
    MSG="SIGNATURE NOT VERIFIED (no minisign tooling on this machine)"
    echo "    $MSG"
    if [ "$ALLOW_UNVERIFIED_SIG" = "1" ]; then
      record "signature:$PLATFORM" "SKIPPED(--allow-unverified-sig)" "$MSG"
    else
      record "signature:$PLATFORM" "FAIL" "$MSG"
    fi
  else
    if verify_signature_for "$PUBKEY_FILE" "$SIGFILE" "$ARTIFACT_FILE"; then
      record "signature:$PLATFORM" "PASS" "minisign signature valid ($MINISIG_TOOL_NAME)"
    else
      record "signature:$PLATFORM" "FAIL" "minisign signature INVALID for $BASENAME ($MINISIG_TOOL_NAME)"
    fi
  fi
done < "$PLATFORMS_LIST"

# ---- summary ------------------------------------------------------------
echo "==> [4/4] Summary"
echo ""
printf "%-26s %-30s %s\n" "CHECK" "STATUS" "DETAIL"
printf "%-26s %-30s %s\n" "-----" "------" "------"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r name status detail <<< "$row"
  printf "%-26s %-30s %s\n" "$name" "$status" "$detail"
done
echo ""

if [ "$ANY_FAIL" = "1" ]; then
  echo "❌ Post-publish verification FAILED for $VERSION_TAG (channel $CHANNEL)."
  exit 1
fi
echo "✅ Post-publish verification PASSED for $VERSION_TAG (channel $CHANNEL)."
