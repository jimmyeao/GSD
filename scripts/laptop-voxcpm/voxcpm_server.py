"""
VoxCPM2 TTS service for Alice (explainer narration + presenter voice samples).

POST /tts     {"text": str, "voice": "bf_alice"}  -> audio/wav (48 kHz), cloned from refs/<voice>.wav (+ .txt transcript)
POST /unload  -> frees the model and CUDA memory (Alice calls this before ComfyUI work)
GET  /health  -> {"ok": true, "loaded": bool, "voices": [...]}
Auth: "Authorization: Bearer <VOXCPM_TOKEN>" on POSTs. The GPU is shared with ComfyUI
(24 GB): the model loads on demand, asks ComfyUI to release its models first (only if
ComfyUI is idle, else 503), and unloads after IDLE_S seconds.
"""
import gc, hmac, io, json, os, re, threading, time, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import soundfile as sf

TOKEN = os.environ.get("VOXCPM_TOKEN", "")
PORT = int(os.environ.get("VOXCPM_PORT", "5200"))
REFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs")
COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
IDLE_S = int(os.environ.get("VOXCPM_IDLE_S", "120"))
MAX_BODY, MAX_TEXT = 64 * 1024, 1200
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]+$")

lock = threading.Lock()
state = {"model": None, "last": 0.0}

def voices():
    return sorted(f[:-4] for f in os.listdir(REFS) if f.endswith(".wav") and os.path.exists(os.path.join(REFS, f[:-4] + ".txt")))

def comfy_busy():
    try:
        q = json.load(urllib.request.urlopen(f"{COMFY}/queue", timeout=3))
        return len(q.get("queue_running", [])) + len(q.get("queue_pending", [])) > 0
    except Exception:
        return False  # ComfyUI down = nothing to protect

def comfy_free():
    try:
        req = urllib.request.Request(f"{COMFY}/free", data=json.dumps({"unload_models": True, "free_memory": True}).encode(), headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass

def unload():
    if state["model"] is not None:
        state["model"] = None
        gc.collect()
        import torch
        torch.cuda.empty_cache()
        print("[voxcpm] unloaded", flush=True)

def ensure_model():
    if state["model"] is None:
        comfy_free()
        from voxcpm import VoxCPM
        t = time.time()
        state["model"] = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
        print(f"[voxcpm] loaded in {time.time()-t:.1f}s", flush=True)
    return state["model"]

def idle_reaper():
    while True:
        time.sleep(15)
        with lock:
            if state["model"] is not None and time.time() - state["last"] > IDLE_S:
                unload()

class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _authed(self):
        got = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "loaded": state["model"] is not None, "voices": voices()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid json"})
        if self.path == "/unload":
            with lock:
                unload()
            return self._json(200, {"ok": True})
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})
        text, voice = str(body.get("text", "")).strip(), str(body.get("voice", "bf_alice"))
        if not text or len(text) > MAX_TEXT:
            return self._json(400, {"error": f"text required (max {MAX_TEXT} chars)"})
        if not VOICE_RE.match(voice) or voice not in voices():
            return self._json(400, {"error": f"unknown voice; available: {voices()}"})
        with lock:
            if state["model"] is None and comfy_busy():
                return self._json(503, {"error": "gpu busy (ComfyUI job running)"})
            try:
                m = ensure_model()
                ref = os.path.join(REFS, voice)
                t = time.time()
                wav = m.generate(text=text, prompt_wav_path=ref + ".wav", prompt_text=open(ref + ".txt").read().strip(),
                                 reference_wav_path=ref + ".wav", cfg_value=2.0, inference_timesteps=10)
                state["last"] = time.time()
                buf = io.BytesIO(); sf.write(buf, wav, m.tts_model.sample_rate, format="WAV"); data = buf.getvalue()
                print(f"[voxcpm] {voice} {len(text)} chars in {time.time()-t:.1f}s", flush=True)
            except Exception as e:
                return self._json(500, {"error": str(e)[:300]})
        self.send_response(200); self.send_header("Content-Type", "audio/wav"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("VOXCPM_TOKEN is not set")
    threading.Thread(target=idle_reaper, daemon=True).start()
    print(f"[voxcpm] serving on 0.0.0.0:{PORT}; voices {voices()}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
