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

LATEST_JSON="$(mktemp -d)/${MANIFEST_NAME}"
python3 - "$VERSION" "$NOTES" "$PUB_DATE" "$ASSET_URL" "$SIG" > "$LATEST_JSON" <<'PY'
import json, sys
version, notes, pub_date, url, sigpath = sys.argv[1:6]
print(json.dumps({
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    # Apple Silicon only for now; add darwin-x86_64 / windows-x86_64 when built.
    "platforms": {
        "darwin-aarch64": {"signature": open(sigpath).read().strip(), "url": url},
    },
}, indent=2))
PY

echo "==> Publishing $TAG to $RELEASE_REPO ($ASSET_NAME, ${CHANNEL} channel → ${MANIFEST_NAME})"
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --title "Adversaria $TAG" \
  --notes "$NOTES" \
  "$ARTIFACT" "$LATEST_JSON"

echo "✅ Published $TAG."
echo "   Manifest: https://github.com/$RELEASE_REPO/releases/latest/download/${MANIFEST_NAME}"
