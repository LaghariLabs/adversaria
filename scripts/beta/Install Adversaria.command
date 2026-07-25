#!/bin/bash
#
# Adversaria — private-beta installer (macOS).
#
# This beta build is not yet notarized by Apple, so macOS quarantines it. Double-
# click this file to copy Adversaria into /Applications and clear that quarantine
# flag so the app can launch. If macOS blocks THIS script, right-click it -> Open
# (or use the manual one-liner in INSTALL.txt).
#
set -euo pipefail

# Folder this script lives in (the mounted .dmg, or an unzipped folder).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="Adversaria.app"
SRC="$HERE/$APP"
DEST="/Applications/$APP"

if [ ! -d "$SRC" ]; then
  echo "X  Could not find $APP next to this installer."
  echo "   Keep 'Install Adversaria.command' in the same folder as Adversaria.app and try again."
  read -n 1 -s -r -p "Press any key to close."
  echo ""
  exit 1
fi

echo "==> Installing Adversaria into /Applications ..."
osascript -e 'quit app "Adversaria"' 2>/dev/null || true   # quit a running copy so we can replace it
sleep 1
rm -rf "$DEST"
ditto "$SRC" "$DEST"

echo "==> Clearing the quarantine flag (lets the un-notarized beta launch) ..."
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "==> Launching Adversaria ..."
open "$DEST" || true

echo ""
echo "OK  Adversaria is installed in your Applications folder."
echo "    On first recording it will ask for Microphone + Screen Recording — that's"
echo "    required to capture the meeting. Nothing leaves your machine."
echo ""
read -n 1 -s -r -p "Press any key to close."
echo ""
