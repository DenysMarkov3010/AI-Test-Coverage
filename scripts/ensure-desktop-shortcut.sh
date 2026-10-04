#!/bin/bash
# Idempotent desktop shortcut for «AI Test Coverage» on macOS.
# If AI Test Coverage.app already exists on the user Desktop AND its launcher is
# current (right project path, right launcher version), exits without doing anything.
# Otherwise (missing, stale after the project folder moved, or built by an older
# create-desktop-shortcut.sh) runs create-desktop-shortcut.sh (same as `npm run shortcut`).
# Called from web-ui-server.js on macOS when the web UI starts.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP="$HOME/Desktop"
APP_PATH="$DESKTOP/AI Test Coverage.app"
LAUNCHER="$APP_PATH/Contents/MacOS/launcher"

# Same stamp create-desktop-shortcut.sh writes into the launcher it generates.
EXPECTED_VERSION="$(sed -n 's/^LAUNCHER_VERSION="\(.*\)"$/\1/p' "$SCRIPT_DIR/create-desktop-shortcut.sh")"

launcher_is_current() {
  [ -f "$LAUNCHER" ] || return 1
  [ -n "$EXPECTED_VERSION" ] || return 1
  grep -qxF "# launcher-version: $EXPECTED_VERSION" "$LAUNCHER" || return 1
  # PROJECT_ROOT is embedded via printf %q, so compare against the same encoding.
  grep -qxF "PROJECT_ROOT=$(printf '%q' "$PROJECT_ROOT")" "$LAUNCHER" || return 1
  [ -x "$APP_PATH/Contents/Resources/start-server.command" ] || return 1
}

if [ -d "$APP_PATH" ] && launcher_is_current; then
  exit 0
fi

exec /bin/bash "$SCRIPT_DIR/create-desktop-shortcut.sh"
