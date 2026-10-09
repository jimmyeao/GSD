/**
 * Client for the VoxCPM2 TTS service on the laptop GPU (see the laptop's
 * ~/tts-ab/voxcpm_server.py): cloned voices that sounded clearly more
 * natural than Kokoro in a blind A/B (2026-10-09). Used for explainer
 * narration and the presenter's voice sample; Kokoro stays the fallback
 * and the engine for Alice's everyday spoken replies.
 *
 * VOXCPM_URL / VOXCPM_TOKEN come from alice-backend/.env. The service
 * shares a 24 GB GPU with ComfyUI, so callers unload() it after a batch.
 */

const URL_ = () => (process.env.VOXCPM_URL ?? '').replace(/\/$/, '');
const TOKEN = () => process.env.VOXCPM_TOKEN ?? '';

const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN()}` });

/** Is the service reachable and does it have this voice? */
export async function voxcpmAvailable(voice) {
  if (!URL_() || !TOKEN()) return false;
  try {
    const res = await fetch(`${URL_()}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const h = await res.json();
    return Array.isArray(h.voices) && h.voices.includes(voice);
  } catch {
    return false;
  }
}

/** Synthesize one line with a cloned voice. Returns a WAV buffer (48 kHz). */
export async function voxcpmSpeak(text, voice) {
  const res = await fetch(`${URL_()}/tts`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(180_000), // first call includes the ~20 s model load
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`VoxCPM2 ${res.status}: ${msg.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Free the laptop GPU for ComfyUI. Never throws. */
export async function voxcpmUnload() {
  try {
    await fetch(`${URL_()}/unload`, { method: 'POST', headers: authHeaders(), body: '{}', signal: AbortSignal.timeout(10_000) });
  } catch { /* service down = nothing loaded */ }
}
