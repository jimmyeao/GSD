/**
 * ComfyUI worker pool: the local GPU (this DGX Spark, managed by
 * comfyManager — starting it stops the LLM) plus remote ComfyUI machines
 * (e.g. the RTX PRO 5000 laptop) that are always on and have their own GPU,
 * so jobs there DON'T take Alice's LLM offline.
 *
 * Remote workers come from COMFY_REMOTE_WORKERS ("name=url,name2=url2").
 * A job lists the model files it needs; a remote worker is used only if it
 * has them all (read from its /object_info, cached) AND it's reachable with
 * an idle queue. Otherwise the job runs locally.
 *
 *   const w = await acquireWorker({ needs, prefer: 'remote' });
 *   try { await generate(w.endpoint, …) } finally { await w.release(); }
 */

import { config } from './config.js';
import { ensureComfyRunning, freeComfyMemory } from './comfyManager.js';

const CAPS_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;
// Loader input that lists each kind of model file in /object_info.
const MODEL_LISTS = {
  UNETLoader: 'unet_name', CheckpointLoaderSimple: 'ckpt_name', LoraLoaderModelOnly: 'lora_name',
  CLIPLoader: 'clip_name', VAELoader: 'vae_name', LatentUpscaleModelLoader: 'model_name', UpscaleModelLoader: 'model_name',
};

export function parseRemoteWorkers(spec = process.env.COMFY_REMOTE_WORKERS ?? '') {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map((entry) => {
    const [name, url] = entry.includes('=') ? entry.split('=') : [entry, entry];
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      return { name: name.trim(), endpoint: u.origin, local: false };
    } catch { return null; }
  }).filter(Boolean);
}

const capsCache = new Map(); // endpoint -> { at, files:Set }

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/**
 * Options of a COMBO input in /object_info. Classic nodes give [[...files]],
 * newer (v3 schema) nodes give ["COMBO", { options: [...files] }] — e.g.
 * LatentUpscaleModelLoader. Missing the second form made a worker look like
 * it lacked a model it had.
 */
export function comboOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (Array.isArray(spec[1]?.options)) return spec[1].options;
  return [];
}

/** All model filenames a worker's ComfyUI can load. */
export async function workerModels(endpoint) {
  const hit = capsCache.get(endpoint);
  if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.files;
  const info = await fetchJson(`${endpoint}/object_info`, 20_000);
  const files = new Set();
  for (const [node, input] of Object.entries(MODEL_LISTS)) {
    for (const f of comboOptions(info?.[node]?.input?.required?.[input])) files.add(f);
  }
  capsCache.set(endpoint, { at: Date.now(), files });
  return files;
}

/** Reachable and nothing running/queued? */
export async function workerIdle(endpoint) {
  try {
    const q = await fetchJson(`${endpoint}/queue`);
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a job's model requirements against a worker's files.
 * `needs` entries are a filename or an array of acceptable alternatives
 * (first present wins), e.g. ['ltx-2.3-22b-dev.safetensors', 'ltx-2.3-22b-dev-fp8.safetensors'].
 * @returns {string[]|null} the chosen file per entry, or null if any is missing
 */
export function resolveNeeds(needs, files) {
  const chosen = [];
  for (const need of needs) {
    const pick = (Array.isArray(need) ? need : [need]).find(f => files.has(f));
    if (!pick) return null;
    chosen.push(pick);
  }
  return chosen;
}

/**
 * Pick a worker for a job.
 * @param {{needs?: (string|string[])[], prefer?: 'remote'|'local', label?: string}} job
 * @returns {Promise<{name, endpoint, local, files: string[], release: () => Promise<void>}>}
 */
export async function acquireWorker({ needs = [], prefer = 'remote', label = 'job' } = {}) {
  if (prefer === 'remote') {
    for (const w of parseRemoteWorkers()) {
      try {
        if (!(await workerIdle(w.endpoint))) { console.log(`[comfyWorkers] ${w.name} busy or unreachable — skipping for ${label}`); continue; }
        const have = await workerModels(w.endpoint);
        const files = resolveNeeds(needs, have);
        if (!files) {
          const missing = needs.filter(n => !(Array.isArray(n) ? n : [n]).some(f => have.has(f))).map(n => (Array.isArray(n) ? n.join(' | ') : n));
          console.log(`[comfyWorkers] ${w.name} lacks ${missing.join(', ')} — skipping for ${label}`);
          continue;
        }
        console.log(`[comfyWorkers] ${label} → ${w.name} (${w.endpoint})`);
        return { ...w, files, release: async () => {} };
      } catch (err) {
        console.warn(`[comfyWorkers] ${w.name} unavailable for ${label}: ${err.message}`);
      }
    }
  }
  // Local GPU: comfyManager owns its lifecycle (and the LLM pause).
  await ensureComfyRunning();
  const endpoint = config.models.comfyui.endpoint;
  let files = [];
  try { files = resolveNeeds(needs, await workerModels(endpoint)) ?? needs.map(n => (Array.isArray(n) ? n[0] : n)); } catch { files = needs.map(n => (Array.isArray(n) ? n[0] : n)); }
  let released = false;
  return {
    name: 'local', endpoint, local: true, files,
    release: async () => { if (!released) { released = true; await freeComfyMemory(); } },
  };
}

/** Pre-check without side effects: would a remote worker take this job right now? */
export async function remoteWorkerFor(needs) {
  for (const w of parseRemoteWorkers()) {
    try {
      if ((await workerIdle(w.endpoint)) && resolveNeeds(needs, await workerModels(w.endpoint))) return w;
    } catch { /* unavailable */ }
  }
  return null;
}
