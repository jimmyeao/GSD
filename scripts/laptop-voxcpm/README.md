# VoxCPM2 TTS service (runs on the laptop GPU worker)

Cloned-voice TTS for explainer narration and presenter voice samples
(Alice falls back to Kokoro when it's unavailable — `src/services/voxcpmClient.js`).

On the GPU machine:

```bash
mkdir -p ~/tts-ab/refs && cd ~/tts-ab
python3 -m venv voxcpm-venv && ./voxcpm-venv/bin/pip install voxcpm soundfile
cp voxcpm_server.py ~/tts-ab/
# one reference per voice: refs/<voice>.wav (~8-10 s clean speech) + refs/<voice>.txt (its transcript)
mkdir -p ~/.config/voxcpm && umask 077 && echo "VOXCPM_TOKEN=<same token as alice-backend/.env>" > ~/.config/voxcpm/env
cp voxcpm-tts.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now voxcpm-tts
loginctl enable-linger $USER   # keep it running without a login session
```

Alice side (`alice-backend/.env`): `VOXCPM_URL=http://<host>:5200`, `VOXCPM_TOKEN=<token>`.
The service shares the GPU with ComfyUI: it frees ComfyUI's models before loading (only
if ComfyUI is idle), and unloads after each batch / 2 min idle.
