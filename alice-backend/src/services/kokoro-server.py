"""
Persistent Kokoro TTS server — loads model once, serves requests fast.
Runs on port 5100 by default.
"""
import io
import os
import sys
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from kokoro_onnx import Kokoro
import soundfile as sf

MODEL_PATH = os.environ.get('KOKORO_MODEL', '/home/jimmy/kokoro-voices/kokoro-v1.0.onnx')
VOICES_PATH = os.environ.get('KOKORO_VOICES', '/home/jimmy/kokoro-voices/voices-v1.0.bin')
PORT = int(os.environ.get('KOKORO_PORT', '5100'))

print(f'[kokoro] Loading model from {MODEL_PATH}...', flush=True)
kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
print(f'[kokoro] Model loaded. Serving on port {PORT}', flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        text = body.get('text', '').strip()
        voice = body.get('voice', 'bf_alice')
        speed = float(body.get('speed', 1.0))

        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"text required"}')
            return

        try:
            samples, sr = kokoro.create(text, voice=voice, speed=speed)
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
