#!/usr/bin/env bash
#
# Build Adversaria.app + Adversaria.dmg for macOS (Apple Silicon).
#
# One command for every release: freeze both pinned Python sidecars, sign every
# nested Mach-O before signing each launcher and the app, build the selected
# updater channel, package the DMG, and optionally notarize it.
#
# Prerequisites on the build machine: Rust toolchain, Node deps (`npm install`),
# uv, and the python-service venv synced (`uv sync --extra mlx`).
#
# Usage:  ADVERSARIA_FORMSPREE_ENDPOINT=https://formspree.io/f/... ./scripts/build-dmg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Codesign identity. Default "-" = ad-hoc (portable, but macOS gives a NEW TCC
# identity on every rebuild, so Screen-Recording / Calendar grants do NOT persist
# and must be re-granted each build). Set ADVERSARIA_SIGN_IDENTITY to a stable
# certificate (e.g. a self-signed "NotchyPrompter Dev" from Keychain Access, or an
# Apple "Developer ID Application") so the app keeps ONE identity and TCC grants
# survive rebuilds. Find identities with: security find-identity -v -p codesigning
SIGN_ID="${ADVERSARIA_SIGN_IDENTITY:--}"
echo "==> Codesign identity: ${SIGN_ID}"

RELEASE_MODE="${ADVERSARIA_RELEASE_MODE:-0}"
if [ "$RELEASE_MODE" = "1" ] && [ "$SIGN_ID" = "-" ]; then
  echo "ERROR: release mode requires a Developer ID Application signing identity."
  exit 1
fi

FORMSPREE_ENDPOINT="${ADVERSARIA_FORMSPREE_ENDPOINT:-}"
if [[ ! "$FORMSPREE_ENDPOINT" =~ ^https://formspree\.io/f/[A-Za-z0-9]+$ ]]; then
  if [ "${ADVERSARIA_ALLOW_INCOMPLETE_REGISTRATION:-0}" != "1" ]; then
    echo "ERROR: set ADVERSARIA_FORMSPREE_ENDPOINT to the production Formspree /f/ endpoint."
    echo "For a non-release packaging smoke only, set ADVERSARIA_ALLOW_INCOMPLETE_REGISTRATION=1."
    exit 1
  fi
  echo "==> WARNING: incomplete registration endpoint allowed for packaging smoke."
else
  export ADVERSARIA_FORMSPREE_ENDPOINT="$FORMSPREE_ENDPOINT"
fi

if [ "$SIGN_ID" = "-" ]; then
  SIGN_ARGS=(--force --sign - --options runtime --timestamp=none)
else
  SIGN_ARGS=(--force --sign "$SIGN_ID" --options runtime --timestamp)
fi

sign_file() {
  # Apple's timestamp service intermittently drops a request ("A timestamp was
  # expected but was not found") — with ~650 signs per build, one flake aborts
  # the whole freeze under `set -e`. Retry before giving up.
  local attempt
  for attempt in 1 2 3; do
    if codesign "${SIGN_ARGS[@]}" "$@"; then
      return 0
    fi
    echo "==> codesign failed (attempt ${attempt}/3): ${*: -1} — retrying in 5s…" >&2
    sleep 5
  done
  return 1
}

sign_macho_tree() {
  local root="$1"
  while IFS= read -r -d '' candidate; do
    if file -b "$candidate" | grep -q "Mach-O"; then
      sign_file "$candidate"
    fi
  done < <(find "$root" -type f -print0)
}

verify_macho_identity_tree() {
  local root="$1"
  local candidate details
  while IFS= read -r -d '' candidate; do
    if file -b "$candidate" | grep -q "Mach-O"; then
      details="$(codesign -dvv "$candidate" 2>&1)"
      if ! grep -Fq "Authority=${SIGN_ID}" <<<"$details"; then
        echo "ERROR: nested code is not signed by ${SIGN_ID}: ${candidate}" >&2
        return 1
      fi
    fi
  done < <(find "$root" -type f -print0)
}

echo "==> [1/7] Freezing the Python ML service (PyInstaller --onedir)…"
cd python-service
rm -rf build dist
# --extra mlx keeps the MLX transcription backend in the freeze env; sherpa-onnx
# (+ its native-lib companion sherpa-onnx-core) is a default dep. Both must be
# present or the frozen sidecar loses transcription / diarization.
uv run --extra mlx --with pyinstaller==6.21.0 pyinstaller adversaria-service.spec --noconfirm

echo "==> [2/7] Freezing the pinned Rapid-MLX runtime…"
./rapid-runtime/build.sh

echo "==> [3/7] Signing nested sidecar code (${SIGN_ID})…"
sign_macho_tree dist/adversaria-service
sign_file --entitlements entitlements.plist \
  dist/adversaria-service/adversaria-service
sign_macho_tree rapid-runtime/dist/rapid-mlx
sign_file --entitlements entitlements.plist \
  rapid-runtime/dist/rapid-mlx/rapid-mlx
codesign --verify --strict --verbose=1 dist/adversaria-service/adversaria-service
codesign --verify --strict --verbose=1 rapid-runtime/dist/rapid-mlx/rapid-mlx

echo "==> [3.5/7] Smoking the frozen sidecars (hygienic env)…"
# A successful PyInstaller run proves only that files were collected. The two
# sidecars get DIFFERENT smokes because they are different kinds of program:
#   * adversaria-service IS an HTTP server (src/server.py's main() takes
#     --host/--port and serves /health), so it gets the full boot → /health →
#     /transcribe gate.
#   * rapid-mlx is a CLI (rapid-runtime/run_rapid.py delegates to
#     vllm_mlx.cli:main, an argparse app with serve/bench/chat/… subcommands).
#     It does NOT accept `--host/--port` and would exit instantly; it gets a
#     launch-integrity check instead (see below).
SMOKE_TMP="$(mktemp -d)"
# Persistent, gitignored HF cache for the smoke's tiny Whisper weights: the
# first build downloads ~75 MB into it, every later build reuses it offline.
# The shipped default (large-v3, ~3 GB) would make this gate unaffordable.
SMOKE_CACHE="${ADVERSARIA_SMOKE_CACHE:-$ROOT/.smoke-cache}"
mkdir -p "$SMOKE_CACHE"
SMOKE_FIXTURE="$ROOT/python-service/tests/fixtures/sample-5s.wav"
SMOKE_WHISPER_REPO="mlx-community/whisper-tiny"
if [ "${ADVERSARIA_SKIP_TRANSCRIBE_SMOKE:-0}" = "0" ]; then
  # Seed the smoke cache before the gate rather than inside it. mlx-whisper
  # fetches its repo at call time, so on a cold cache the download happens
  # *inside* the /transcribe request — measured at ~20 minutes on the release
  # Mac, which is indistinguishable from a hung transcription. Doing it here,
  # with the build machine's own venv, makes a slow first fetch visible
  # progress; on a warm cache it is a sub-second no-op.
  echo "  -- Seeding the smoke Whisper cache ($SMOKE_WHISPER_REPO → $SMOKE_CACHE)…"
  HF_HOME="$SMOKE_CACHE" HF_HUB_DISABLE_XET=1 \
    uv run python -c 'import sys; from huggingface_hub import snapshot_download; snapshot_download(sys.argv[1])' \
    "$SMOKE_WHISPER_REPO"
fi
SMOKE_OUT="$SMOKE_TMP/adversaria-service.stdout.log"
SMOKE_ERR="$SMOKE_TMP/adversaria-service.stderr.log"
SMOKE_HOME="$(mktemp -d)"
SMOKE_DATA="$SMOKE_TMP/app-data"
mkdir -p "$SMOKE_DATA"
SMOKE_PID=""

smoke_fail() {
  echo "ERROR: $1" >&2
  echo "--- adversaria-service stdout ---" >&2
  cat "$SMOKE_OUT" >&2 2>/dev/null || true
  echo "--- adversaria-service stderr ---" >&2
  cat "$SMOKE_ERR" >&2 2>/dev/null || true
  if [ -n "$SMOKE_PID" ]; then
    kill "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_HOME"
  echo "(smoke scratch dir kept for debugging: $SMOKE_TMP)" >&2
  exit 1
}

SMOKE_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
echo "  -- adversaria-service: boot → /health → /transcribe on 127.0.0.1:${SMOKE_PORT}"
# Hygienic env. PATH is deliberately /usr/bin:/bin — NO Homebrew: a Homebrew
# `ffmpeg` on the build machine would mask a bundling gap, and that exact bug
# shipped once (docs/TODO.md, "ffmpeg dependency"). Since 0.3.50 the service
# decodes in-process via PyAV, so it must pass without any Homebrew on PATH.
# ADVERSARIA_DATA_DIR (NOT ADVERSARIA_APP_DATA) is the app-data override the
# service actually reads — see python-service/src/config.py.
env -i HOME="$SMOKE_HOME" PATH="/usr/bin:/bin" \
  ADVERSARIA_DATA_DIR="$SMOKE_DATA" \
  HF_HOME="$SMOKE_CACHE" \
  HF_HUB_DISABLE_XET=1 \
  MLX_WHISPER_MODEL="$SMOKE_WHISPER_REPO" \
  "$ROOT/python-service/dist/adversaria-service/adversaria-service" \
  --host 127.0.0.1 --port "$SMOKE_PORT" >"$SMOKE_OUT" 2>"$SMOKE_ERR" &
SMOKE_PID=$!

# Wait for transcriber_state=ready, not merely for /health to answer: the
# service binds its port while the transcriber is still loading, and a
# /transcribe issued in that window 503s ("transcriber_loading") — which is
# what made the first version of this gate fail against a healthy build.
# `missing`/`error` are terminal, so fail on them immediately instead of
# burning the whole budget.
SMOKE_READY=0
SMOKE_BOUND=0
for _ in $(seq 1 150); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    smoke_fail "adversaria-service exited before answering /health."
  fi
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" -m 5 -o "$SMOKE_TMP/health.json" 2>/dev/null; then
    SMOKE_BOUND=1
    SMOKE_STATE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("transcriber_state") or "")' "$SMOKE_TMP/health.json")"
    case "$SMOKE_STATE" in
      ready)
        SMOKE_READY=1
        echo "     /health OK: $(cat "$SMOKE_TMP/health.json")"
        break
        ;;
      missing|error)
        smoke_fail "adversaria-service came up with transcriber_state=$SMOKE_STATE: $(cat "$SMOKE_TMP/health.json")"
        ;;
    esac
  fi
  sleep 2
done
if [ "$SMOKE_READY" != "1" ]; then
  smoke_fail "adversaria-service never reached transcriber_state=ready within 300s (port bound: $SMOKE_BOUND)."
fi

if [ "${ADVERSARIA_SKIP_TRANSCRIBE_SMOKE:-0}" != "0" ]; then
  echo "  !! ADVERSARIA_SKIP_TRANSCRIBE_SMOKE=1 — THE /transcribe GATE IS SKIPPED."
  echo "  !! This build has NOT been proven able to transcribe. Only use this for a"
  echo "  !! deliberately offline build, and never for a release you intend to ship."
else
  [ -f "$SMOKE_FIXTURE" ] || smoke_fail "smoke fixture missing: $SMOKE_FIXTURE"
  # /transcribe takes JSON with an on-disk path — the service and the app are on
  # the same machine, so audio is never uploaded (see src/server.py::transcribe
  # and src/models.py::TranscribeRequest). It is NOT a multipart upload.
  # ~2 s against a warm cache on an M-series Mac; 300 s is pure headroom.
  SMOKE_BODY="$(python3 -c 'import json,sys; print(json.dumps({"audio_path": sys.argv[1], "diarize": False}))' "$SMOKE_FIXTURE")"
  curl -fsS -X POST "http://127.0.0.1:$SMOKE_PORT/transcribe" \
    -H 'Content-Type: application/json' -d "$SMOKE_BODY" \
    -m 300 -o "$SMOKE_TMP/transcribe.json" \
    || smoke_fail "/transcribe failed on the frozen service."
  python3 - "$SMOKE_TMP/transcribe.json" <<'PY' || smoke_fail "/transcribe returned no usable text."
import json, sys

data = json.load(open(sys.argv[1]))
text = (data.get("text") or "").strip()
print(f"     /transcribe OK -> {text[:120]!r}")
sys.exit(0 if len(text) >= 10 else 1)
PY
fi
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
SMOKE_PID=""
rm -rf "$SMOKE_HOME"

echo "  -- rapid-mlx: launch-integrity check…"
# What this PROVES: the signed, frozen binary is allowed to execute (codesign /
# entitlements / Gatekeeper did not kill it), its PyInstaller bootloader starts
# the embedded CPython, and run_rapid.py's `from vllm_mlx.cli import main`
# resolves from inside the bundle — that import is unconditional and happens
# BEFORE argparse ever sees `--version`, so exit 0 here is real evidence.
# What it does NOT prove: that mlx.core / Metal loads, or that a model can be
# served. `vllm_mlx/__init__.py` is deliberately lazy ("All imports are lazy to
# allow usage on non-Apple Silicon platforms"), so every heavy import happens
# inside a subcommand handler; the only invocation that would exercise them is
# actually serving a model, which needs multi-GB weights a release build must
# not download. `rapid-mlx doctor` is no better — its package rows come from
# importlib.metadata, not real imports, and it exits 1 by design when the
# binary is not on $PATH. Verified against the frozen binary 2026-08-07.
RAPID_LOG="$SMOKE_TMP/rapid-mlx.log"
RAPID_HOME="$(mktemp -d)"
env -i HOME="$RAPID_HOME" PATH="/usr/bin:/bin" \
  "$ROOT/python-service/rapid-runtime/dist/rapid-mlx/rapid-mlx" --version \
  >"$RAPID_LOG" 2>&1 &
RAPID_PID=$!
( sleep 120; kill -9 "$RAPID_PID" 2>/dev/null || true ) &
RAPID_WATCHDOG=$!
RAPID_RC=0
wait "$RAPID_PID" || RAPID_RC=$?
kill "$RAPID_WATCHDOG" 2>/dev/null || true
wait "$RAPID_WATCHDOG" 2>/dev/null || true
rm -rf "$RAPID_HOME"
# Gate on the OUTPUT as well as the exit code: a bundle that printed a dyld or
# import error and still exited 0 must not pass.
if [ "$RAPID_RC" != "0" ] \
   || ! grep -q '^rapid-mlx ' "$RAPID_LOG" \
   || grep -Eq 'ImportError|ModuleNotFoundError|dyld|Symbol not found|Library not loaded|Killed' "$RAPID_LOG"; then
  echo "ERROR: rapid-mlx failed its launch-integrity check (exit $RAPID_RC). Output:" >&2
  cat "$RAPID_LOG" >&2 || true
  echo "(smoke scratch dir kept for debugging: $SMOKE_TMP)" >&2
  exit 1
fi
echo "     launch OK: $(cat "$RAPID_LOG")"

rm -rf "$SMOKE_TMP"
echo "  Frozen sidecar smoke PASSED."
cd "$ROOT"

# Updater signing. When the minisign private key exists, export the Tauri signing
# env so `tauri build` emits a signed `.app.tar.gz` + `.sig` (the updater artifact,
# enabled by bundle.createUpdaterArtifacts). The key lives OUTSIDE the repo; it is
# never committed. Without it the build still succeeds but produces no update
# artifact. Generate once: `npm run tauri signer generate -w ~/.tauri/adversaria-updater.key -p ""`.
UPDATER_KEY="${ADVERSARIA_UPDATER_KEY:-$HOME/.tauri/adversaria-updater.key}"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> Updater signing key supplied by the build environment."
elif [ -f "$UPDATER_KEY" ]; then
  echo "==> Updater signing key found ($UPDATER_KEY) — will sign update artifacts."
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${ADVERSARIA_UPDATER_KEY_PASSWORD:-}"
  if [ -f "${UPDATER_KEY}.pub" ]; then
    PINNED_UPDATER_PUBLIC_KEY="$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json')).plugins.updater.pubkey")"
    LOCAL_UPDATER_PUBLIC_KEY="$(tr -d '\r\n' < "${UPDATER_KEY}.pub")"
    if [ "$PINNED_UPDATER_PUBLIC_KEY" != "$LOCAL_UPDATER_PUBLIC_KEY" ]; then
      echo "ERROR: updater private key's public pair does not match tauri.conf.json."
      exit 1
    fi
    echo "==> Updater public key matches the verifier key pinned in the app."
  fi
else
  echo "==> WARNING: no updater signing key at $UPDATER_KEY — update artifacts will NOT be signed."
fi

if [ "$RELEASE_MODE" = "1" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "ERROR: release mode requires the Tauri updater signing private key."
  exit 1
fi

if [ "$RELEASE_MODE" = "1" ] && [ -z "${ADVERSARIA_NOTARY_PROFILE:-}" ]; then
  echo "ERROR: release mode requires ADVERSARIA_NOTARY_PROFILE."
  exit 1
fi

# Prove the notarization credential WORKS before spending an hour signing hundreds
# of Mach-Os. Twice now (0.3.73, 0.3.75) a full release build ran to stage 7 and
# died at notarization because the app-specific password behind the Keychain
# profile had been revoked out-of-band. `notarytool` reports a revoked credential
# as "No Keychain password item found", which reads like a missing profile and
# sends you looking in the wrong place. This turns an hour into five seconds.
if [ "$RELEASE_MODE" = "1" ]; then
  echo "==> [0/7] Checking the notarization credential before building…"
  if ! xcrun notarytool history --keychain-profile "$ADVERSARIA_NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "ERROR: the notarization credential '$ADVERSARIA_NOTARY_PROFILE' is not usable."
    echo "       notarytool says this whether the profile is missing OR its"
    echo "       app-specific password has been revoked — the message cannot tell"
    echo "       them apart, so re-store it and only dig deeper if that fails:"
    echo
    echo "         xcrun notarytool store-credentials $ADVERSARIA_NOTARY_PROFILE \\"
    echo "           --apple-id <apple-id> --team-id 4MY4PH5PHC"
    echo
    echo "       An App Store Connect API key (--key/--key-id/--issuer) survives"
    echo "       Apple Account password changes and avoids this entirely."
    exit 1
  fi
  echo "    credential OK."
fi

CHANNEL="${ADVERSARIA_RELEASE_CHANNEL:-beta}"
case "$CHANNEL" in
  beta|stable) ;;
  *) echo "ERROR: ADVERSARIA_RELEASE_CHANNEL must be beta or stable."; exit 1 ;;
esac
echo "==> [4/7] Building the Tauri .app for the ${CHANNEL} updater channel…"
npm run tauri build -- --config "src-tauri/tauri.${CHANNEL}.conf.json"

# Tauri ad-hoc-signs the .app; re-sign the main bundle with our identity so the
# main binary has the stable TCC identity (the sidecar keeps its signature above).
echo "==> [5/7] Signing and validating the complete app bundle (${SIGN_ID})…"
APP="src-tauri/target/release/bundle/macos/Adversaria.app"
sign_macho_tree "$APP/Contents/Resources/adversaria-service"
sign_file --entitlements python-service/entitlements.plist \
  "$APP/Contents/Resources/adversaria-service/adversaria-service"
sign_macho_tree "$APP/Contents/Resources/rapid-mlx"
sign_file --entitlements python-service/entitlements.plist \
  "$APP/Contents/Resources/rapid-mlx/rapid-mlx"
sign_file --entitlements src-tauri/entitlements-app.plist "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
if [ -n "${ADVERSARIA_NOTARY_PROFILE:-}" ]; then
  echo "==> Verifying Developer ID authority on every nested Mach-O…"
  verify_macho_identity_tree "$APP"
fi
if [ "$SIGN_ID" != "-" ]; then
  # Gatekeeper normally rejects a correctly Developer-ID-signed app until Apple
  # accepts the notarization submission. Record that expected intermediate state
  # and defer the hard gate until after stapling.
  if ! spctl --assess --type execute --verbose=2 "$APP"; then
    if [ -n "${ADVERSARIA_NOTARY_PROFILE:-}" ]; then
      echo "==> Pre-notarization Gatekeeper rejection recorded (expected); final assessment follows stapling."
    else
      echo "==> Note: signed but unnotarized build is Gatekeeper-rejected; configure ADVERSARIA_NOTARY_PROFILE before distributing it."
    fi
  fi
fi

# `tauri build` creates the updater archive before this script applies the final
# nested/app signatures. Repack and re-sign it now so the updater and DMG carry
# the exact same finally signed application bundle.
UPDATER_ARCHIVE="src-tauri/target/release/bundle/macos/Adversaria.app.tar.gz"
echo "==> Repacking the updater from the finally signed app…"
COPYFILE_DISABLE=1 tar -czf "$UPDATER_ARCHIVE" \
  -C "$(dirname "$APP")" "$(basename "$APP")"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  npm run tauri -- signer sign "$UPDATER_ARCHIVE"
else
  rm -f "${UPDATER_ARCHIVE}.sig"
fi

UPDATER_VERIFY_DIR="$(mktemp -d)"
tar -xzf "$UPDATER_ARCHIVE" -C "$UPDATER_VERIFY_DIR"
diff -qr "$APP" "$UPDATER_VERIFY_DIR/Adversaria.app"
codesign --verify --deep --strict --verbose=1 \
  "$UPDATER_VERIFY_DIR/Adversaria.app"
rm -rf "$UPDATER_VERIFY_DIR"

echo "==> [6/7] Packaging the .dmg (hdiutil — reliable, no AppleScript)…"
OUT="${ADVERSARIA_DMG_OUTPUT:-src-tauri/target/release/bundle/dmg/Adversaria_aarch64.dmg}"
mkdir -p "$(dirname "$OUT")"
STAGING="$(mktemp -d)"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

# Private-beta convenience: until the app is notarized with a Developer ID, a
# downloaded build is quarantined and testers must clear it (xattr) to launch it.
# Bundle a double-click installer + plain-text instructions into the .dmg for any
# NON-notarized build (i.e. when no Apple Developer ID is set). A notarized
# Developer ID build launches normally and doesn't need this — so it's omitted then.
if [ "$SIGN_ID" = "-" ]; then
  cp "$ROOT/scripts/beta/Install Adversaria.command" "$STAGING/"
  chmod +x "$STAGING/Install Adversaria.command"
  cp "$ROOT/scripts/beta/INSTALL.txt" "$STAGING/"
  echo "==> Bundled the beta installer (Install Adversaria.command + INSTALL.txt) into the .dmg (un-notarized build)."
fi

rm -f "$OUT"
hdiutil create -volname "Adversaria" -srcfolder "$STAGING" -ov -format UDZO "$OUT"
rm -rf "$STAGING"

if [ "$SIGN_ID" != "-" ]; then
  echo "==> Signing and validating the DMG (${SIGN_ID})…"
  codesign --force --sign "$SIGN_ID" --timestamp "$OUT"
  codesign --verify --strict --verbose=2 "$OUT"
fi

echo "==> [7/7] Optional notarization and final provenance…"

if [ -n "${ADVERSARIA_NOTARY_PROFILE:-}" ]; then
  if [ "$SIGN_ID" = "-" ]; then
    echo "ERROR: notarization requires a Developer ID Application identity."
    exit 1
  fi
  # Retry the submit. Twice (0.3.73, 0.3.75) a release build reached this line and
  # failed with "No Keychain password item found" — not because the credential was
  # gone, but because it was momentarily unreachable: both failures landed right
  # after signing hundreds of Mach-Os, with a load average near 10, and the same
  # credential worked seconds later on an idle machine. notarytool reports that
  # transient lookup failure identically to a missing profile, so the only way to
  # tell them apart is to try again. An hour of signing must not be thrown away by
  # one unlucky Keychain read.
  notarize_attempt=0
  until xcrun notarytool submit "$OUT" \
    --keychain-profile "$ADVERSARIA_NOTARY_PROFILE" --wait; do
    notarize_attempt=$((notarize_attempt + 1))
    if [ "$notarize_attempt" -ge 4 ]; then
      echo "ERROR: notarization failed $notarize_attempt times."
      echo "       If every attempt said 'No Keychain password item found', re-store"
      echo "       the credential — notarytool cannot distinguish a revoked password"
      echo "       from a profile that is missing:"
      echo "         xcrun notarytool store-credentials $ADVERSARIA_NOTARY_PROFILE \\"
      echo "           --apple-id <apple-id> --team-id 4MY4PH5PHC"
      echo "       The signed DMG is intact at $OUT — notarize it directly rather"
      echo "       than rebuilding."
      exit 1
    fi
    backoff=$((notarize_attempt * 20))
    echo "==> notarization attempt $notarize_attempt failed; retrying in ${backoff}s…"
    sleep "$backoff"
  done
  xcrun stapler staple "$OUT"
  xcrun stapler validate "$OUT"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$OUT"
else
  echo "==> Notarization skipped: ADVERSARIA_NOTARY_PROFILE is not configured."
fi

# Stapling changes the DMG bytes, so provenance must describe the final artifact
# rather than the pre-notarization container submitted to Apple.
node scripts/release-provenance.mjs "$OUT" \
  "src-tauri/target/release/bundle/provenance-${CHANNEL}.json" \
  "$UPDATER_ARCHIVE" "${UPDATER_ARCHIVE}.sig"

# A stable-named copy for the website's download link. The versioned filename
# changes every release, so a link to
# .../releases/latest/download/Adversaria-<version>-... silently 404s the moment
# the next version ships. This name never changes, so the site link keeps working.
# Copied AFTER stapling so it carries the notarization ticket.
STABLE_DMG="$(dirname "$OUT")/Adversaria-macos-arm64.dmg"
if [ "$OUT" != "$STABLE_DMG" ]; then
  cp -f "$OUT" "$STABLE_DMG"
  echo "==> Stable download name: $STABLE_DMG"
fi

# Auto-install into /Applications so you're always running the build you just
# made (set ADVERSARIA_INSTALL=0 to skip). Quits + replaces + relaunches.
if [ "${ADVERSARIA_INSTALL:-0}" != "0" ]; then
  echo "==> Installing to /Applications + relaunching…"
  osascript -e 'quit app "Adversaria"' 2>/dev/null || true
  sleep 2
  rm -rf /Applications/Adversaria.app
  ditto "$APP" /Applications/Adversaria.app
  open -a Adversaria || true
  echo "   Installed v$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Adversaria.app/Contents/Info.plist 2>/dev/null) to /Applications and relaunched."
fi

# Clean up frozen debug artifacts that poison dev (Phase 0.4)
if [ -d "$ROOT/src-tauri/target/debug" ]; then
  if ls "$ROOT/src-tauri/target/debug"/adversaria-service* >/dev/null 2>&1; then
    echo "==> Cleaning debug sidecar artifacts (de-poison dev)..."
    # -r: the --onedir freeze makes these DIRECTORIES; plain rm failed on them
    # and its exit code became the whole build's exit AFTER a fully successful
    # notarized artifact (0.3.77 cut, 2026-08-14).
    rm -rf "$ROOT/src-tauri/target/debug"/adversaria-service*
  fi
fi

echo ""
echo "✅ Done."
echo "   App: $APP"
echo "   DMG: $OUT"
echo "   DMG (stable name): $STABLE_DMG"
