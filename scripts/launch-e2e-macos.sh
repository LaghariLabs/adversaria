#!/bin/bash

# AppKit can abort in _RegisterApplication when a newly rebuilt .app executable
# is spawned directly. LaunchServices is the supported macOS launch path, so
# the WDIO harness delegates to `open` while keeping a foreground supervisor
# process that the Tauri service can stop after the suite.

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${ADVERSARIA_E2E_APP_BUNDLE:-$ROOT_DIR/src-tauri/target/debug/bundle/macos/Adversaria.app}"
SOURCE_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/meeting-note-taker"
STAGING_DIR=""
STAGED_APP=""
APP_EXECUTABLE=""
OPEN_PID=""
OPEN_ENV_ARGS=()

terminate_app() {
  if [[ -n "$OPEN_PID" ]]; then
    kill -TERM "$OPEN_PID" 2>/dev/null || true
  fi

  # `open -W` is only a LaunchServices waiter; terminating it does not always
  # terminate the application it launched. Restrict cleanup to this exact E2E
  # bundle executable so an installed production copy is never touched.
  if [[ -n "$APP_EXECUTABLE" ]]; then
    pkill -TERM -f "^${APP_EXECUTABLE}( |$)" 2>/dev/null || true
  fi

  if [[ -n "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
}

trap terminate_app TERM INT EXIT

if [[ ! -x "$SOURCE_EXECUTABLE" ]]; then
  echo "E2E application executable not found: $SOURCE_EXECUTABLE" >&2
  exit 1
fi

# LaunchServices delegates app startup to launchd. On privacy-protected project
# paths such as ~/Documents, launchd can fail with EACCES even though the test
# runner itself may read the bundle. Stage the signed disposable app under /tmp
# so the launch path matches what an installed app receives.
STAGING_DIR="$(mktemp -d /tmp/adversaria-e2e-app.XXXXXX)"
# macOS reports /tmp process paths as /private/tmp. Canonicalize before forming
# the cleanup matcher so the staged app cannot outlive its WDIO supervisor.
STAGING_DIR="$(cd "$STAGING_DIR" && pwd -P)"
STAGED_APP="$STAGING_DIR/Adversaria.app"
/usr/bin/ditto --noqtn "$APP_BUNDLE" "$STAGED_APP"
/usr/bin/xattr -cr "$STAGED_APP"
APP_EXECUTABLE="$STAGED_APP/Contents/MacOS/meeting-note-taker"

# Be explicit: LaunchServices may reuse a registered application environment
# instead of forwarding every variable from `open`. These are the only values
# the isolated E2E app needs from the WebdriverIO service.
for NAME in \
  ADVERSARIA_DATA_DIR \
  TAURI_WEBDRIVER_PORT \
  WDIO_EMBEDDED_SERVER \
  RUST_LOG; do
  if /usr/bin/printenv "$NAME" >/dev/null 2>&1; then
    OPEN_ENV_ARGS+=(--env "$NAME=${!NAME}")
  fi
done

/usr/bin/open \
  -F \
  -W \
  -n \
  "${OPEN_ENV_ARGS[@]}" \
  "$STAGED_APP" \
  --args "$@" &
OPEN_PID=$!

wait "$OPEN_PID"
STATUS=$?
OPEN_PID=""
trap - TERM INT EXIT
exit "$STATUS"
