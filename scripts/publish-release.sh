#!/usr/bin/env bash
#
# Publish an Adversaria auto-update release to the PUBLIC release channel
# (LaghariLabs/adversaria-releases). Run AFTER ./scripts/build-dmg.sh, which — when
# the updater signing key is present — emits the signed updater artifact
# (Adversaria.app.tar.gz + .sig) alongside the .app/.dmg.
#
# What it does: reads the version from tauri.conf.json, writes a latest.json
# manifest from the signature, and creates a GitHub release tagged vX.Y.Z with the
# .app.tar.gz + latest.json as assets. The app's updater endpoint
# (.../releases/latest/download/latest.json) then serves it to installed clients.
#
# Usage:  ./scripts/publish-release.sh ["release notes"]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_REPO="${ADVERSARIA_RELEASE_REPO:-LaghariLabs/adversaria-releases}"
NOTES="${1:-Maintenance update.}"
BUNDLE="src-tauri/target/release/bundle/macos"

# The manifest name MUST match the endpoint baked into the installed app for that
# channel: tauri.beta.conf.json polls latest-beta.json, tauri.stable.conf.json
# polls latest-stable.json. Default to the same channel build-dmg.sh defaults to
# (beta) so a beta build and its published manifest line up — otherwise clients
# poll a file that was never published and the "Update available" toast never fires.
CHANNEL="${ADVERSARIA_RELEASE_CHANNEL:-beta}"
case "$CHANNEL" in
  beta|stable) ;;
  *) echo "ERROR: ADVERSARIA_RELEASE_CHANNEL must be beta or stable."; exit 1 ;;
esac
MANIFEST_NAME="latest-${CHANNEL}.json"

# Tauri names the macOS updater artifact "<productName>.app.tar.gz"; glob to be safe.
ARTIFACT="$(ls "$BUNDLE"/*.app.tar.gz 2>/dev/null | head -1 || true)"
[ -n "$ARTIFACT" ] || { echo "No *.app.tar.gz in $BUNDLE — run ./scripts/build-dmg.sh with the updater key first."; exit 1; }
SIG="$ARTIFACT.sig"
[ -f "$SIG" ] || { echo "No signature ($SIG) — the build didn't sign the artifact (missing updater key?)."; exit 1; }

VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
TAG="v$VERSION"
ASSET_NAME="$(basename "$ARTIFACT")"
ASSET_URL="https://github.com/$RELEASE_REPO/releases/download/$TAG/$ASSET_NAME"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Windows half of the manifest. A manifest with no windows-x86_64 entry is why
# Windows users have never seen an update prompt (2026-08-03): the app polls,
# gets a macOS-only document, and correctly concludes there is nothing for it.
# Point ADVERSARIA_WINDOWS_DIR at a directory holding the CI build's
# `*-setup.exe` AND `*-setup.exe.sig` — e.g.
#   gh run download <run-id> --repo LaghariLabs/meeting-note-taker -D /tmp/win
# NOTE: with `createUpdaterArtifacts: true` (tauri.conf.json) Tauri v2 re-uses
# the NSIS installer itself as the update bundle, so the pair is
# `-setup.exe` + `-setup.exe.sig`. The `.nsis.zip` shape belongs to
# `"v1Compatible"` and is NOT what this build produces.
WIN_EXE=""
WIN_SIG=""
if [ -n "${ADVERSARIA_WINDOWS_DIR:-}" ]; then
  WIN_EXE="$(find "$ADVERSARIA_WINDOWS_DIR" -name '*-setup.exe' -type f 2>/dev/null | head -1 || true)"
  [ -n "$WIN_EXE" ] || { echo "ERROR: no *-setup.exe under $ADVERSARIA_WINDOWS_DIR."; exit 1; }
  WIN_SIG="$WIN_EXE.sig"
  [ -f "$WIN_SIG" ] || {
    echo "ERROR: $WIN_EXE has no .sig next to it — that CI build had no updater signing key,"
    echo "       so it produced an installer-only candidate. Add TAURI_SIGNING_PRIVATE_KEY"
    echo "       (+ _PASSWORD) to the PUBLIC repo's Actions secrets and re-run the build."
    exit 1
  }
fi
# The website links .../releases/latest/download/Adversaria-windows-x64-setup.exe,
# so publish under that stable name and point the updater at the same asset.
WIN_ASSET_NAME="Adversaria-windows-x64-setup.exe"
WIN_URL="https://github.com/$RELEASE_REPO/releases/download/$TAG/$WIN_ASSET_NAME"

LATEST_JSON="$(mktemp -d)/${MANIFEST_NAME}"
python3 - "$VERSION" "$NOTES" "$PUB_DATE" "$ASSET_URL" "$SIG" "$WIN_URL" "$WIN_SIG" > "$LATEST_JSON" <<'PY'
import json, sys
version, notes, pub_date, url, sigpath, win_url, win_sig = sys.argv[1:8]
platforms = {
    # Apple Silicon only on the mac side; add darwin-x86_64 when one is built.
    "darwin-aarch64": {"signature": open(sigpath).read().strip(), "url": url},
}
if win_sig:
    platforms["windows-x86_64"] = {
        "signature": open(win_sig).read().strip(),
        "url": win_url,
    }
print(json.dumps({
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": platforms,
}, indent=2))
PY

echo "==> Publishing $TAG to $RELEASE_REPO ($ASSET_NAME, ${CHANNEL} channel → ${MANIFEST_NAME})"
# The DMG is what humans download; the .app.tar.gz is only for the auto-updater.
# Upload both, using the STABLE filename so the website's
# .../releases/latest/download/Adversaria-macos-arm64.dmg link keeps working
# across releases. Uploading it by hand is how a release ships with no download.
ALLOW_MISSING_DMG=0
ALLOW_MACOS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --allow-missing-dmg) ALLOW_MISSING_DMG=1 ;;
    --allow-macos-only) ALLOW_MACOS_ONLY=1 ;;
  esac
done

DMG="$(dirname "$ARTIFACT")/../dmg/Adversaria-macos-arm64.dmg"
DMG_ARGS=()
if [ -f "$DMG" ]; then
  DMG_ARGS+=("$DMG")
else
  if [ "$ALLOW_MISSING_DMG" = "1" ]; then
    echo "==> WARNING: $DMG not found — publishing without a downloadable DMG (--allow-missing-dmg)."
  else
    echo "ERROR: $DMG not found. Re-run scripts/build-dmg.sh or pass --allow-missing-dmg to publish without it."
    exit 1
  fi
fi

WIN_ARGS=()
if [ -n "$WIN_EXE" ]; then
  WIN_STAGED="$(mktemp -d)/$WIN_ASSET_NAME"
  cp "$WIN_EXE" "$WIN_STAGED"
  WIN_ARGS+=("$WIN_STAGED")
  echo "==> Including Windows: $(basename "$WIN_EXE") → $WIN_ASSET_NAME (signed, windows-x86_64)"
  # Record the Windows exe in the channel provenance NOW, while the bytes in
  # hand are the authentic ones being uploaded. build-dmg.sh only covers the
  # macOS artifacts, so without this the Windows asset ships with no recorded
  # hash and scripts/verify-published.sh can never hold it to the same
  # standard (found live: 0.3.75's provenance carries no windows entry).
  PROV_FILE="src-tauri/target/release/bundle/provenance-${CHANNEL}.json"
  if [ -f "$PROV_FILE" ]; then
    python3 - "$PROV_FILE" "$WIN_STAGED" "$WIN_ASSET_NAME" <<'PY'
import hashlib, json, sys
prov_path, staged, asset_name = sys.argv[1], sys.argv[2], sys.argv[3]
prov = json.load(open(prov_path))
arts = prov.setdefault("distribution_artifacts", [])
data = open(staged, "rb").read()
entry = {"filename": asset_name, "bytes": len(data),
         "sha256": hashlib.sha256(data).hexdigest()}
arts[:] = [a for a in arts if a.get("filename") != asset_name] + [entry]
json.dump(prov, open(prov_path, "w"), indent=2)
print(f"==> Provenance: recorded {asset_name} ({entry['bytes']:,} B, sha256 {entry['sha256'][:16]}…)")
PY
  else
    echo "==> WARNING: no provenance at $PROV_FILE — the Windows asset will publish with no recorded hash."
  fi
else
  if [ "$ALLOW_MACOS_ONLY" = "1" ]; then
    echo "==> WARNING: no Windows artifacts (ADVERSARIA_WINDOWS_DIR unset) — publishing macOS-only (--allow-macos-only)."
  else
    echo "ERROR: no Windows artifacts (ADVERSARIA_WINDOWS_DIR unset). Set ADVERSARIA_WINDOWS_DIR or pass --allow-macos-only for a macOS-only release."
    exit 1
  fi
fi

# Create draft release first so we can verify before publishing
echo "==> Creating draft release $TAG..."
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --title "Adversaria $TAG" \
  --notes "$NOTES" \
  --draft \
  "$ARTIFACT" "$LATEST_JSON" ${DMG_ARGS+"${DMG_ARGS[@]}"} ${WIN_ARGS+"${WIN_ARGS[@]}"}

# Verify uploaded assets — hard-fail on any missing asset
echo "==> Verifying uploaded assets..."
ASSETS_JSON="$(gh release view "$TAG" --repo "$RELEASE_REPO" --json assets --jq '.assets | map(.name) | join("\n")')"
MISSING=0
for expected in "$(basename "$ARTIFACT")" "$(basename "$LATEST_JSON")" ${DMG_ARGS:+"$(basename "$DMG")"} ${WIN_ARGS:+"$WIN_ASSET_NAME"}; do
  # Handle empty DMG_ARGS/WIN_ARGS gracefully
  [ -z "$expected" ] && continue
  if ! echo "$ASSETS_JSON" | grep -qxF "$expected"; then
    echo "ERROR: Expected asset missing from draft release: $expected"
    echo "Assets on draft: $ASSETS_JSON"
    MISSING=1
  fi
done
if [ "$MISSING" = "1" ]; then
  echo "ERROR: Draft release verification failed — deleting draft $TAG."
  gh release delete "$TAG" --repo "$RELEASE_REPO" --yes 2>/dev/null || true
  exit 1
fi
echo "==> Asset verification passed."

# Undraft (publish) the release
gh release edit "$TAG" --repo "$RELEASE_REPO" --draft=false --latest
echo "==> Published $TAG (undrafted)."

# Post-publish verifier — same logic as scripts/verify-published.sh
VERIFY_SCRIPT="$ROOT/scripts/verify-published.sh"
if [ -f "$VERIFY_SCRIPT" ]; then
  echo "==> Running post-publish verifier..."
  "$VERIFY_SCRIPT" "$TAG" "$CHANNEL" || {
    echo "ERROR: Post-publish verification failed for $TAG."
    exit 1
  }
else
  echo "==> WARNING: scripts/verify-published.sh not found — skipping post-publish verification."
fi

echo "✅ Published and verified $TAG."
echo "   Manifest: https://github.com/$RELEASE_REPO/releases/latest/download/${MANIFEST_NAME}"
[ -n "$WIN_EXE" ] || echo "   Windows clients: NOT served by this release (see --allow-macos-only)."
