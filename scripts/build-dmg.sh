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
  xcrun notarytool submit "$OUT" \
    --keychain-profile "$ADVERSARIA_NOTARY_PROFILE" --wait
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

echo ""
echo "✅ Done."
echo "   App: $APP"
echo "   DMG: $OUT"
