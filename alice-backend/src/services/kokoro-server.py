"""
Persistent Kokoro TTS server — loads model once, serves requests fast.
Runs on port 5100 by default.
"""
import io
import os
import sys
import json
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from kokoro_onnx import Kokoro
import soundfile as sf

MODEL_PATH = os.environ.get('KOKORO_MODEL', '/home/jimmy/kokoro-voices/kokoro-v1.0.onnx')
VOICES_PATH = os.environ.get('KOKORO_VOICES', '/home/jimmy/kokoro-voices/voices-v1.0.bin')
PORT = int(os.environ.get('KOKORO_PORT', '5100'))

PIPER_DIR = os.environ.get('PIPER_VOICES', '/home/jimmy/piper-voices')
# voice name (as sent by the backend) -> Piper model file
PIPER_VOICES = {
    'jarvis': 'en_US-Jarvis_Real-medium.onnx',
}
_piper_cache = {}
# The Jarvis voice was fine-tuned on only 300 sentences, so sounds that are rare
# there come out mangled — the American flap (ɾ) in "status"/"data"/"water" was
# heard as "stoic"/"stillest" (Whisper A/B, 2026-10-23). Plain t is well covered.
PIPER_PHONEME_FIX = {'ɾ': 't'}

print(f'[kokoro] Loading model from {MODEL_PATH}...', flush=True)
kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
print(f'[kokoro] Model loaded. Serving on port {PORT}', flush=True)


def piper_wav(voice, text, speed):
    """Synthesize with a Piper voice (loaded on first use). Returns WAV bytes."""
    import wave
    from piper import PiperVoice, SynthesisConfig
    pv = _piper_cache.get(voice)
    if pv is None:
        path = os.path.join(PIPER_DIR, PIPER_VOICES[voice])
        print(f'[kokoro] Loading Piper voice {voice} from {path}...', flush=True)
        pv = _piper_cache[voice] = PiperVoice.load(path)
    # Speed scales the voice's own trained length_scale (>1 = faster).
    length_scale = pv.config.length_scale / max(speed, 0.1)
    syn = SynthesisConfig(length_scale=length_scale)
    gap = np.zeros(int(pv.config.sample_rate * 0.2), dtype='<i2').tobytes()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(pv.config.sample_rate)
        # Phonemize ourselves so we can patch phonemes before synthesis.
        for i, sent in enumerate(pv.phonemize(text)):
            sent = [PIPER_PHONEME_FIX.get(p, p) for p in sent]
            audio = np.asarray(pv.phoneme_ids_to_audio(pv.phonemes_to_ids(sent), syn)).reshape(-1)
            # Same peak normalisation as PiperVoice.synthesize().
            pcm = (audio * (32767.0 / max(0.01, float(np.abs(audio).max())))).clip(-32767, 32767).astype('<i2')
            if i:
                w.writeframes(gap)
            w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        text = body.get('text', '').strip()
        voice = body.get('voice', 'bf_alice')
        speed = float(body.get('speed', 1.0))
        # Phonemize in the voice's own accent. kokoro-onnx defaults to en-us,
        # so British voices (bf_/bm_) were reading American phonemes —
        # e.g. "copy" as kˈɑːpi ("kah-pee") instead of kˈɒpɪ.
        lang = body.get('lang') or ('en-gb' if voice[:1] == 'b' else 'en-us')
        if lang not in ('en-gb', 'en-us'):
            lang = 'en-us'

        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"text required"}')
            return

        try:
            if voice in PIPER_VOICES:
                wav = piper_wav(voice, text, speed)
            else:
                samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
                buf = io.BytesIO()
                sf.write(buf, samples, sr, format='WAV')
                wav = buf.getvalue()

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, fmt, *args):
        # Compact logging
        print(f'[kokoro] {args[0]}', flush=True)


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'[kokoro] Ready on http://0.0.0.0:{PORT}', flush=True)
    server.serve_forever()
