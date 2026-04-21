#!/bin/bash
# Start Xvfb → fluxbox → x11vnc → websockify (noVNC) → love <workspace>
#
# `exec love .` at the end ties the container's lifetime to the game process,
# so when the user quits the game (or the game crashes) the container exits
# cleanly and the backend can clean it up.
set -eu

# 1. Virtual X display
Xvfb "$DISPLAY" -screen 0 "$SCREEN_SIZE" -nolisten tcp &
XVFB_PID=$!

# Wait for Xvfb to accept connections — cheap busy-loop, usually <500ms
for i in $(seq 1 30); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# (No window manager: LÖVE creates its own OpenGL window and an extra WM
# caused X BadMatch errors on focus. It's unnecessary for a single-window
# game.)

# 2. VNC server — exposes the Xvfb display on localhost:5900
x11vnc \
  -display "$DISPLAY" \
  -rfbport "$VNC_PORT" \
  -forever \
  -shared \
  -nopw \
  -noxdamage \
  -quiet \
  -bg

# 3. noVNC via websockify — serves the HTML/JS from the novnc package on
#    port 6080 AND bridges the /websockify path to the VNC socket. The
#    backend proxies both to the browser.
websockify \
  --web=/usr/share/novnc \
  "$NOVNC_PORT" \
  "localhost:$VNC_PORT" &
WS_PID=$!

# Clean up child processes on shutdown
trap 'kill "$XVFB_PID" "$WS_PID" 2>/dev/null || true' EXIT TERM INT

# 5. The game. Must have main.lua at LOVE_DIR root.
if [ ! -f "$LOVE_DIR/main.lua" ]; then
  echo "ERROR: $LOVE_DIR/main.lua not found — LÖVE needs main.lua at project root" >&2
  sleep 5
  exit 1
fi

cd "$LOVE_DIR"
exec love .
