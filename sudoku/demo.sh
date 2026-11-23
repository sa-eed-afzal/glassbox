#!/usr/bin/env bash
# sudoku/demo.sh — one-command demo rig for recording the Glassbox + Sudoku flow.
#
# Starts:  a static server for sudoku/ on 127.0.0.1:3002
#          a supervised glassbox bridge (ephemeral port, no daemon)
# Then mints a one-shot connect code for the page.
#
# Open http://127.0.0.1:3002 in a browser and paste the printed code into the
# widget. Ctrl-C stops both processes. Re-run to mint a fresh code.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAGE_PORT="${PAGE_PORT:-3002}"
ORIGIN="http://127.0.0.1:$PAGE_PORT"
LOG_DIR="${TMPDIR:-/tmp}"
cd "$ROOT"

# The bundled SDK must match the current build (it is generated, not hand-edited).
if [[ ! -f dist/cli.js ]]; then
  echo "demo: building dist/ (first run)"
  npm run build
fi
if ! cmp -s dist/glassbox.js sudoku/glassbox.js; then
  cp dist/glassbox.js sudoku/glassbox.js
  echo "demo: re-synced sudoku/glassbox.js from dist/"
fi

echo "demo: starting page on $ORIGIN"
python3 -m http.server "$PAGE_PORT" --bind 127.0.0.1 --directory sudoku \
  >"$LOG_DIR/glassbox-page.log" 2>&1 &
PAGE_PID=$!

# Keep stdin open so the bridge doesn't exit; the MCP client normally does this.
tail -f /dev/null | node dist/cli.js bridge >"$LOG_DIR/glassbox-bridge.log" 2>&1 &
BRIDGE_PID=$!

cleanup() {
  kill "$PAGE_PID" "$BRIDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT

PORT=""
for _ in $(seq 1 50); do
  PORT="$(grep -o 'glassbox host on 127.0.0.1:[0-9]*' "$LOG_DIR/glassbox-bridge.log" \
    | tail -1 | grep -o '[0-9]*$' || true)"
  [[ -n "$PORT" ]] && break
  sleep 0.1
done
if [[ -z "$PORT" ]]; then
  echo "demo: bridge failed to start; see $LOG_DIR/glassbox-bridge.log" >&2
  exit 1
fi

echo "demo: bridge on 127.0.0.1:$PORT (ephemeral — read it from stderr in a real MCP client)"
echo
echo "1. open   $ORIGIN"
echo "2. paste the code below into the widget within 60 s"
echo "3. ask your MCP client's agent to call, e.g., 'call get_state' then 'call new_game'"
echo
echo "--- CONNECT CODE (one-shot, 60 s, bound to $ORIGIN) ---"
node dist/cli.js code --port "$PORT" --app sudoku-game --origin "$ORIGIN" --quiet
echo "--- END CODE ---"
echo
echo "Re-mint any time: node dist/cli.js code --port $PORT --app sudoku-game --origin $ORIGIN --quiet"
echo "Drop --quiet to also print an ASCII QR on stderr for the phone-camera shot."
echo "Live channels:    node dist/cli.js channels --port $PORT"
echo
echo "Recording until Ctrl-C ..."
wait
