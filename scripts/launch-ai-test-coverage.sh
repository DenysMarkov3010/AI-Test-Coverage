#!/bin/bash
# AI Test Coverage — start the web UI (if needed) and open the app in the browser.
# Mirrors launch-ai-test-coverage.ps1 for macOS.
# Run from the Desktop .app launcher or: bash scripts/launch-ai-test-coverage.sh

set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WEB_UI_PORT:-3847}"
WEB_URL="http://127.0.0.1:${PORT}/"
HEALTH_URL="${WEB_URL}__da/health"

test_web_ui_up() {
  curl -sf -o /dev/null --max-time 2 "$HEALTH_URL"
}

if [ ! -f "$PROJECT_ROOT/web-ui-server.js" ]; then
  /usr/bin/osascript -e "display dialog \"web-ui-server.js was not found in:\\n$PROJECT_ROOT\" buttons {\"OK\"} default button \"OK\" with title \"AI Test Coverage\"" >/dev/null 2>&1 || true
  exit 1
fi

# The server runs in a Terminal window you own, which is the whole point: `nohup … &` left it with
# no window at all, so there was nothing to Ctrl+C — and a server nobody can stop is a server that
# keeps serving the code it was started with. One left running across five days of edits is exactly
# how the Setup page ends up showing fields that no longer exist.
#
# The Windows sibling has always done this (Start-Process -WindowStyle Minimized); this is macOS
# catching up, not a new idea.
start_in_terminal() {
  local app="${AI_TEST_COVERAGE_TERMINAL_APP:-Terminal}"
  # `cd` is quoted for the shell, then the whole command is escaped for the AppleScript string
  # literal that carries it — the project path has spaces in it.
  local cmd="cd '$PROJECT_ROOT' && npm run web"
  local escaped
  escaped=$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
  /usr/bin/osascript >/dev/null 2>&1 \
    -e "tell application \"$app\" to do script \"$escaped\"" \
    -e "tell application \"$app\" to activate"
}

# Last resort only: a detached server beats no server, but it is the state this script exists to
# avoid, so it says where the log went.
start_detached() {
  local user_shell="${SHELL:-/bin/zsh}"
  "$user_shell" -lc "cd \"$PROJECT_ROOT\" && nohup npm run web >/tmp/ai-test-coverage.log 2>&1 &" || true
  echo "Terminal could not be opened — the server is detached, log: /tmp/ai-test-coverage.log" >&2
}

if ! test_web_ui_up; then
  start_in_terminal || start_detached
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.4
    if test_web_ui_up; then break; fi
  done
fi

# Always prefer Chrome on macOS. Try bundle ID first (locale-proof), then the
# display name, then the explicit .app path; fall back to the user's default
# browser only if no Chrome variant is installed.
open_in_chrome() {
  /usr/bin/open -b com.google.Chrome "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -a "Google Chrome" "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -b com.google.Chrome.canary "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -a "Google Chrome Canary" "$WEB_URL" 2>/dev/null && return 0
  if [ -d "/Applications/Google Chrome.app" ]; then
    /usr/bin/open -a "/Applications/Google Chrome.app" "$WEB_URL" 2>/dev/null && return 0
  fi
  return 1
}

if ! open_in_chrome; then
  /usr/bin/osascript -e "display dialog \"Google Chrome was not found. Opening in the default browser.\\n\\n$WEB_URL\" buttons {\"OK\"} default button \"OK\" with title \"AI Test Coverage\"" >/dev/null 2>&1 || true
  /usr/bin/open "$WEB_URL"
fi
