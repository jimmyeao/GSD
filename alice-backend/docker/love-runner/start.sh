#!/bin/bash
# KasmVNC (v1.4.x) + PulseAudio + LÖVE.
#
# kasmvncserver is a Perl wrapper: it forks Xvnc + websockify and returns
# once they're started. We DON'T background it with `&` — it daemonises
# itself. When we're ready, we exec `love .` as PID 1 so the container
# lives as long as the game.
set -eu

# 1. VNC password — created on first run, persisted in volume for next time.
if [ ! -f "$HOME/.kasmpasswd" ]; then
  printf 'alicelove\nalicelove\n' | kasmvncpasswd -u kasm -w
fi

# KasmVNC 1.4 prompts interactively for a desktop environment if
# ~/.vnc/xstartup doesn't exist. We don't want any DE (LÖVE is the whole
# "desktop"), so pre-create an empty xstartup to bypass the prompt.
mkdir -p "$HOME/.vnc"
if [ ! -f "$HOME/.vnc/xstartup" ]; then
  cat > "$HOME/.vnc/xstartup" <<'EOF'
#!/bin/sh
# Intentionally empty — LÖVE is launched separately by start.sh once
# Xvnc is up. Xvnc will otherwise spawn a DE here.
exec /bin/true
EOF
  chmod +x "$HOME/.vnc/xstartup"
fi
# kasmvncserver checks ~/.vnc/.de-was-selected to decide whether to
# prompt for a desktop environment. Touching it bypasses the prompt
# permanently — we've already committed to "manual" (empty xstartup).
touch "$HOME/.vnc/.de-was-selected"

# 2. PulseAudio user daemon — no external clients, auto-spawns sinks as
#    LÖVE connects. Non-fatal if it fails to start (game will run without audio).
export PULSE_RUNTIME_PATH="$HOME/.pulse"
mkdir -p "$PULSE_RUNTIME_PATH"
pulseaudio \
  --start \
  --exit-idle-time=-1 \
  --disable-shm=true \
  --log-target=stderr \
  --log-level=1 \
  || echo "[start.sh] pulseaudio failed to start — continuing silently"
export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"

# 3. KasmVNC — starts Xvnc on :99 + websockify on $KASMVNC_PORT. Returns
#    once the server is accepting connections. NO `&` because the wrapper
#    daemonises internally.
kasmvncserver :99 \
  -geometry "$SCREEN_SIZE" \
  -depth 24 \
  -websocketPort "$KASMVNC_PORT" \
  -localhost no \
  -sslOnly 0 \
  -interface 0.0.0.0

export DISPLAY=:99

# 4. Make sure Xvnc is actually up before starting the game — otherwise
#    SDL's x11 init fails with "x11 not available" and LÖVE aborts.
for i in $(seq 1 60); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "[start.sh] FATAL: Xvnc display :99 never came up. Recent log:" >&2
  tail -40 "$HOME/.vnc/"*.log 2>/dev/null || true
  sleep 5
  exit 1
fi

# 5. Teardown: kill Xvnc + PulseAudio when love exits (or trap fires).
trap 'kasmvncserver -kill :99 2>/dev/null || true; pulseaudio --kill 2>/dev/null || true' EXIT TERM INT

# 6. Run the game. main.lua must exist at LOVE_DIR root.
if [ ! -f "$LOVE_DIR/main.lua" ]; then
  echo "[start.sh] FATAL: $LOVE_DIR/main.lua not found — LÖVE needs main.lua at project root" >&2
  sleep 5
  exit 1
fi

cd "$LOVE_DIR"
exec love .
