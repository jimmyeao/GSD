/**
 * External agent API — lets a tool/agent OUTSIDE this Node process (e.g.
 * OpenHands) call Alice's generation capabilities directly over HTTP.
 *
 * Routes mount under /agent (see server.js). Behind NGINX all client calls
 * go to /api/agent/* — NGINX strips the /api prefix before proxying.
 *
 * Auth is requireApiKey (shared secret), NOT expressAuth (cookie session) —
 * an external caller has no browser session to present. Mounted before the
 * global csrfProtect in server.js for the same reason: CSRF's double-
 * submit-cookie contract assumes a browser.
 *
 * No user/conversation attribution: generated media isn't saved as Alice
 * assets (that requires a real users-table row — see saveAsset in
 * server.js) — this returns the file bytes directly to the caller instead.
 *
 * Async job-polling, not synchronous request/response (2026-09-18 redesign):
 * Cloudflare's edge kills any proxied response past ~100-125s regardless of
 * any timeout set here server-side — confirmed in production by an external
 * caller (video generation reliably 524'd past ~2s of requested duration;
 * image generation was borderline, since Flux.2 Dev alone can exceed that
 * window). A POST now only starts the job and returns a job_id immediately;
 * the caller polls GET /agent/<kind>/:job_id until status is 'done' (or
 * 'error'), at which point the actual bytes come back. This is a breaking
 * change from the original synchronous contract — any existing caller needs
 * to switch from "await the POST" to "POST, then poll".
 *
 * mode: 'chain' (2026-09-19) runs a sequence of clips end-to-end, auto-
 * feeding each clip's extracted last frame into the next clip's firstFrame
 * (same last-frame->first-frame technique a caller could already do by hand
 * across separate /video calls + GET .../last-frame), then merges every clip
 * server-side with scripts/concat_videos.py (crossfaded, same tool the
 * in-app chained-video chat agent uses) so the caller gets back one file
 * instead of stitching clips themselves.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireApiKey } from '../auth.js';
import { config } from '../config.js';
import { generateImage } from '../agents/comfyClient.js';
import { generateLTXVideo, generateLTXI2V, generateLTXFL2V } from '../agents/videoClient.js';
import { ensureComfyRunning, freeComfyMemory } from '../comfyManager.js';
import { generateCrowd, MAX_CROWD_COUNT } from '../agents/crowdClient.js';
import { generateMesh3D } from '../agents/mesh3dClient.js';

const router = Router();
router.use(requireApiKey);

const VALID_IMAGE_MODELS = new Set(['auto', 'flux2']);
const VALID_ASPECTS = new Set(['square', 'landscape', 'portrait']);
const VALID_VIDEO_MODES = new Set(['t2v', 'i2v', 'fl2v']);
// Same directory generateLTXVideo/I2V/FL2V's pollForVideo already caches
// into (see videoClient.js) — read the file it already wrote instead of a
// redundant fetch from ComfyUI's /view, unlike images (generateImage doesn't
// cache locally on its own).
const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = join(__dirname, '..', '..', 'data', 'videos');
// Same python venv + merge script the in-app ChainedVideoAgent uses (see
// handleChainedVideoAgent in server.js) — reused as-is rather than
// reimplementing the crossfade merge here.
const COMFYUI_PYTHON_BIN = `${process.env.COMFYUI_VENV_DIR ?? '/home/jimmy/comfyui-env'}/bin/python`;
const CONCAT_SCRIPT = join(__dirname, '..', '..', 'scripts', 'concat_videos.py');

// ── In-memory job store ─────────────────────────────────────────────────
// No DB needed — matches this API's existing "no persistence" design (see
// header). GET is idempotent and NEVER deletes a job on fetch (2026-09-18 —
// an earlier version deleted on first GET, which meant a transient failure
// between us and the caller, e.g. a Cloudflare 502 on that exact response,
// silently and permanently lost an already-generated result with no way to
// retry). The sweep below is the only thing that ever removes a job, purely
// by age from creation — a generous, retry-safe 30 min regardless of how
// many times (or how unsuccessfully) it's been polled.
const jobs = new Map(); // id -> { kind, status: 'processing'|'done'|'error', result, error, createdAt }
const JOB_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — applies once a job is done/error
// A multi-member /crowd batch can legitimately still be 'processing' well
// past 30 min (each member is a full image-gen + shape-gen + texture-paint
// cycle, several minutes on its own) — the age-based sweep used to apply
// uniformly regardless of status, which would delete a large batch out from
// under itself before it ever finished. Still-processing jobs get a much
// longer ceiling so a genuinely stuck job doesn't leak forever, but a
// legitimately-running big batch survives.
const PROCESSING_JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3h

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const maxAge = job.status === 'processing' ? PROCESSING_JOB_MAX_AGE_MS : JOB_MAX_AGE_MS;
    if (job.createdAt < now - maxAge) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

function createJob(kind) {
  const id = randomUUID();
  jobs.set(id, { kind, status: 'processing', result: null, error: null, createdAt: Date.now() });
  return id;
}

function isOfflineError(err) {
  return err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed');
}

// ── Image ────────────────────────────────────────────────────────────────

async function runImageJob(id, { prompt, negativePrompt, imageModel, imageAspect, upscale4k, width, height }) {
  const job = jobs.get(id);
  try {
    await ensureComfyRunning();
    // Flux.2 Dev is a 32B model — same longer budget handleImageAgent uses
    // for the chat path (see server.js). No longer constrained by Cloudflare's
    // ~100s ceiling now that this runs after the POST has already responded.
    const timeoutMs = imageModel === 'flux2' ? 600_000 : config.models.comfyui.timeout;
    const customSize = (width && height) ? { width, height } : null;
    const imgData = await generateImage(config.models.comfyui.endpoint, prompt, negativePrompt, timeoutMs, imageModel, imageAspect, upscale4k, customSize);

    const viewUrl = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
    const imgRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`Failed to fetch generated image from ComfyUI (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    freeComfyMemory();

    job.status = 'done';
    job.result = { filename: imgData.filename, mimeType: 'image/png', buffer };
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.isOffline = isOfflineError(err);
  }
}

router.post('/image', (req, res) => {
  const {
    prompt,
    negativePrompt = '',
    imageModel = 'auto',
    imageAspect = 'square',
    upscale4k = false,
    width,
    height,
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) is required' });
  }
  if (!VALID_IMAGE_MODELS.has(imageModel)) {
    return res.status(400).json({ error: `imageModel must be one of: ${[...VALID_IMAGE_MODELS].join(', ')}` });
  }
  if (!VALID_ASPECTS.has(imageAspect)) {
    return res.status(400).json({ error: `imageAspect must be one of: ${[...VALID_ASPECTS].join(', ')}` });
  }
  if ((width && !height) || (height && !width)) {
    return res.status(400).json({ error: 'width and height must be provided together' });
  }

  const id = createJob('image');
  runImageJob(id, { prompt, negativePrompt, imageModel, imageAspect, upscale4k, width, height });
  res.status(202).json({ job_id: id, status_url: `/agent/image/${id}` });
});

router.get('/image/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'image') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') return res.json({ status: 'processing' });

  // Deliberately NOT deleted here — a transient failure between us and the
  // caller (e.g. a Cloudflare 502 on this exact response) used to mean the
  // result was gone forever with no way to retry, since we'd already
  // deleted it the instant this handler started running, regardless of
  // whether the bytes actually made it back. GET is now idempotent: repeat
  // polls just re-serve the same cached result until the timed sweep at
  // the top of this file expires it (30 min from creation, not from last
  // fetch) — a deliberately generous, retry-safe window over "delete on
  // first attempt."
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }

  res.json({
    filename: job.result.filename,
    mime_type: job.result.mimeType,
    image_base64: job.result.buffer.toString('base64'),
  });
});

// ── Video ────────────────────────────────────────────────────────────────

async function runVideoJob(id, { mode, prompt, durationSeconds, width, height, firstFrame, lastFrame, extractLastFrame }) {
  const job = jobs.get(id);
  // Generous but not H3-scale — LTX is the "faster" model (real runs this
  // session measured well under 10 min even at 12s default duration). No
  // longer constrained by Cloudflare's ~100s ceiling — see header.
  const timeoutMs = 900_000;
  try {
    await ensureComfyRunning();
    let vidData;
    if (mode === 'i2v') {
      vidData = await generateLTXI2V(config.models.comfyui.endpoint, prompt, firstFrame, timeoutMs, durationSeconds, width, height, undefined, extractLastFrame);
    } else if (mode === 'fl2v') {
      vidData = await generateLTXFL2V(config.models.comfyui.endpoint, prompt, firstFrame, lastFrame, timeoutMs, durationSeconds, width, height, undefined, extractLastFrame);
    } else {
      vidData = await generateLTXVideo(config.models.comfyui.endpoint, prompt, timeoutMs, durationSeconds, width, height, undefined, extractLastFrame);
    }
    freeComfyMemory();

    const cachedPath = join(VIDEOS_DIR, vidData.filename);
    const buffer = readFileSync(cachedPath);
    try { unlinkSync(cachedPath); } catch { /* not fatal — file just lingers */ }

    job.status = 'done';
    job.result = { filename: vidData.filename, mimeType: 'video/mp4', buffer };
    // vidData.lastFrame is { name, dataUrl: "data:image/png;base64,..." }
    // (see pollForVideo in videoClient.js) — decode once here so the
    // separate GET .../last-frame route below can serve it as raw bytes,
    // same shape as everything else in this file.
    if (vidData.lastFrame) {
      const base64 = vidData.lastFrame.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      job.lastFrame = { filename: vidData.lastFrame.name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
    }
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.isOffline = isOfflineError(err);
  }
}

const isValidFrame = (f) => f && typeof f.name === 'string' && typeof f.dataUrl === 'string';

// ── Chain (multi-clip, server-side merge) ──────────────────────────────────

async function runChainVideoJob(id, { clips }) {
  const job = jobs.get(id);
  const timeoutMs = 900_000;
  const clipPaths = [];
  try {
    await ensureComfyRunning();

    let previousLastFrame = null;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const mode = c.mode || (i === 0 ? 't2v' : 'i2v');
      const width = c.width || 1280;
      const height = c.height || 720;
      const durationSeconds = c.durationSeconds || 12;
      const firstFrame = c.firstFrame || previousLastFrame;
      // Always extract — needed to feed the next clip, and cheap to also
      // hand back on the final clip via last_frame_url below.
      let vidData;
      if (mode === 'i2v') {
        vidData = await generateLTXI2V(config.models.comfyui.endpoint, c.prompt, firstFrame, timeoutMs, durationSeconds, width, height, undefined, true);
      } else if (mode === 'fl2v') {
        vidData = await generateLTXFL2V(config.models.comfyui.endpoint, c.prompt, firstFrame, c.lastFrame, timeoutMs, durationSeconds, width, height, undefined, true);
      } else {
        vidData = await generateLTXVideo(config.models.comfyui.endpoint, c.prompt, timeoutMs, durationSeconds, width, height, undefined, true);
      }

      clipPaths.push(join(VIDEOS_DIR, vidData.filename));
      previousLastFrame = vidData.lastFrame
        ? { name: vidData.lastFrame.name, dataUrl: vidData.lastFrame.dataUrl }
        : null;

      job.progress = { completed: i + 1, total: clips.length };
    }
    freeComfyMemory();

    if (previousLastFrame) {
      const base64 = previousLastFrame.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      job.lastFrame = { filename: previousLastFrame.name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
    }

    if (clipPaths.length === 1) {
      // A single-clip "chain" is just that clip — no merge needed.
      job.status = 'done';
      job.result = { filename: clipPaths[0].split('/').pop(), mimeType: 'video/mp4', buffer: readFileSync(clipPaths[0]) };
    } else {
      const mergedFilename = `alice_chain_${Date.now()}.mp4`;
      const mergedPath = join(VIDEOS_DIR, mergedFilename);
      await new Promise((resolve, reject) => {
        execFile(COMFYUI_PYTHON_BIN, [CONCAT_SCRIPT, mergedPath, ...clipPaths], (err, stdout, stderr) => {
          if (err) reject(new Error(`concat_videos.py failed: ${stderr || err.message}`));
          else resolve();
        });
      });
      job.status = 'done';
      job.result = { filename: mergedFilename, mimeType: 'video/mp4', buffer: readFileSync(mergedPath) };
      try { unlinkSync(mergedPath); } catch { /* not fatal — file just lingers */ }
    }
    for (const p of clipPaths) { try { unlinkSync(p); } catch { /* not fatal — file just lingers */ } }
  } catch (err) {
    for (const p of clipPaths) { try { unlinkSync(p); } catch { /* not fatal */ } }
    job.status = 'error';
    job.error = err.message;
    job.isOffline = isOfflineError(err);
  }
}

function handleChainPost(req, res) {
  const { clips } = req.body || {};
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips (non-empty array) is required for mode "chain"' });
  }

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c || !c.prompt || typeof c.prompt !== 'string') {
      return res.status(400).json({ error: `clips[${i}].prompt (string) is required` });
    }
    const clipMode = c.mode || (i === 0 ? 't2v' : 'i2v');
    if (!VALID_VIDEO_MODES.has(clipMode)) {
      return res.status(400).json({ error: `clips[${i}].mode must be one of: ${[...VALID_VIDEO_MODES].join(', ')}` });
    }
    // Only clip 0 can lack a predecessor to auto-chain from — every later
    // clip may omit firstFrame and inherit the previous clip's last frame.
    if (i === 0 && (clipMode === 'i2v' || clipMode === 'fl2v') && !isValidFrame(c.firstFrame)) {
      return res.status(400).json({ error: `clips[0].firstFrame ({name, dataUrl}) is required when clips[0].mode is "${clipMode}"` });
    }
    if (clipMode === 'fl2v' && !isValidFrame(c.lastFrame)) {
      return res.status(400).json({ error: `clips[${i}].lastFrame ({name, dataUrl}) is required for mode "fl2v"` });
    }
  }

  // concat_videos.py assumes every decoded clip shares one frame size (it
  // sizes the output stream from clips[0] alone) — catch a mismatch here
  // with a clear error instead of a cryptic PyAV shape-mismatch failure
  // after minutes of GPU time have already been spent.
  const width = clips[0].width || 1280;
  const height = clips[0].height || 720;
  for (let i = 1; i < clips.length; i++) {
    const w = clips[i].width || width;
    const h = clips[i].height || height;
    if (w !== width || h !== height) {
      return res.status(400).json({ error: `all clips must share the same width/height for merging (clips[0] is ${width}x${height}, clips[${i}] is ${w}x${h})` });
    }
  }

  const id = createJob('video');
  runChainVideoJob(id, { clips });
  res.status(202).json({ job_id: id, status_url: `/agent/video/${id}` });
}

router.post('/video', (req, res) => {
  const { mode = 't2v' } = req.body || {};
  if (mode === 'chain') return handleChainPost(req, res);

  const {
    prompt,
    durationSeconds = 12,
    width = 1280,
    height = 720,
    firstFrame,
    lastFrame,
    extractLastFrame = false,
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) is required' });
  }
  if (!VALID_VIDEO_MODES.has(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${[...VALID_VIDEO_MODES].join(', ')}, chain` });
  }
  if ((mode === 'i2v' || mode === 'fl2v') && !isValidFrame(firstFrame)) {
    return res.status(400).json({ error: 'firstFrame ({name, dataUrl}) is required for i2v/fl2v mode' });
  }
  if (mode === 'fl2v' && !isValidFrame(lastFrame)) {
    return res.status(400).json({ error: 'lastFrame ({name, dataUrl}) is required for fl2v mode' });
  }

  const id = createJob('video');
  runVideoJob(id, { mode, prompt, durationSeconds, width, height, firstFrame, lastFrame, extractLastFrame });
  res.status(202).json({
    job_id: id,
    status_url: `/agent/video/${id}`,
    // Only meaningful once the job is done AND extractLastFrame was true —
    // included up front so a chaining caller doesn't need to guess the URL
    // shape. GET on it 404s until then (see below).
    last_frame_url: extractLastFrame ? `/agent/video/${id}/last-frame` : null,
  });
});

router.get('/video/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'video') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') {
    // job.progress only exists for chain jobs — plain lets a caller show
    // "2/5 clips" progress instead of a single opaque "processing".
    return res.json({ status: 'processing', progress: job.progress ?? null });
  }

  // Same "don't delete on fetch" reasoning as GET /image/:id above — GET is
  // idempotent, cleanup only happens via the timed sweep.
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }

  res.set('Content-Type', job.result.mimeType);
  res.set('Content-Disposition', `attachment; filename="${job.result.filename}"`);
  res.send(job.result.buffer);
});

// Separate from GET /video/:id (which always serves the video itself) so a
// clip-chaining caller can fetch just the frame they need for the next
// generation's firstFrame — no video-decode step of their own required.
// Only present when the original POST had extractLastFrame: true.
router.get('/video/:id/last-frame', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'video') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }
  if (!job.lastFrame) {
    return res.status(404).json({ error: 'no last frame was extracted for this job — pass extractLastFrame: true in the original POST' });
  }

  res.set('Content-Type', job.lastFrame.mimeType);
  res.set('Content-Disposition', `attachment; filename="${job.lastFrame.filename}"`);
  res.send(job.lastFrame.buffer);
});

// ── Mesh (single asset, any subject — not just crowd characters) ───────

async function runMeshJob(id, { prompt, image, imageModel, imageAspect, upscale4k, width, height }) {
  const job = jobs.get(id);
  try {
    const { glbBuffer, previewBuffer } = await generateMesh3D({ prompt, image, imageModel, imageAspect, upscale4k, width, height });
    job.status = 'done';
    job.result = { filename: 'asset.glb', mimeType: 'model/gltf-binary', buffer: glbBuffer };
    if (previewBuffer) job.preview = { filename: 'asset_preview.png', mimeType: 'image/png', buffer: previewBuffer };
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.isOffline = isOfflineError(err);
  }
}

router.post('/mesh', (req, res) => {
  const {
    prompt,
    image,
    imageModel = 'auto',
    imageAspect = 'square',
    upscale4k = false,
    width,
    height,
  } = req.body || {};

  if (!prompt && !image) {
    return res.status(400).json({ error: 'either prompt (string) or image ({name, dataUrl}) is required' });
  }
  if (prompt && image) {
    return res.status(400).json({ error: 'provide only one of prompt or image, not both' });
  }
  if (prompt && typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt must be a string' });
  }
  if (image && !isValidFrame(image)) {
    return res.status(400).json({ error: 'image must be {name, dataUrl} (same shape as video firstFrame)' });
  }
  if (!VALID_IMAGE_MODELS.has(imageModel)) {
    return res.status(400).json({ error: `imageModel must be one of: ${[...VALID_IMAGE_MODELS].join(', ')}` });
  }
  if (!VALID_ASPECTS.has(imageAspect)) {
    return res.status(400).json({ error: `imageAspect must be one of: ${[...VALID_ASPECTS].join(', ')}` });
  }
  if ((width && !height) || (height && !width)) {
    return res.status(400).json({ error: 'width and height must be provided together' });
  }

  const id = createJob('mesh');
  runMeshJob(id, { prompt, image, imageModel, imageAspect, upscale4k, width, height });
  res.status(202).json({
    job_id: id,
    status_url: `/agent/mesh/${id}`,
    preview_url: `/agent/mesh/${id}/preview`,
  });
});

router.get('/mesh/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'mesh') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }

  res.set('Content-Type', job.result.mimeType);
  res.set('Content-Disposition', `attachment; filename="${job.result.filename}"`);
  res.send(job.result.buffer);
});

// Quick visual sanity-check render without needing a 3D viewer — same
// "separate sibling route" pattern as /video/:id/last-frame above.
router.get('/mesh/:id/preview', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'mesh') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }
  if (!job.preview) return res.status(404).json({ error: 'no preview render available for this job' });

  res.set('Content-Type', job.preview.mimeType);
  res.set('Content-Disposition', `attachment; filename="${job.preview.filename}"`);
  res.send(job.preview.buffer);
});

// ── Crowd (batch: N distinct textured 3D characters, zipped) ───────────

async function runCrowdJob(id, { count }) {
  const job = jobs.get(id);
  try {
    const { buffer, members } = await generateCrowd(count, {
      onProgress: (p) => { job.progress = p; },
    });
    job.status = 'done';
    job.result = { filename: `crowd_${count}.zip`, mimeType: 'application/zip', buffer };
    job.members = members;
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.isOffline = isOfflineError(err);
  }
}

router.post('/crowd', (req, res) => {
  const { count = 1 } = req.body || {};
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CROWD_COUNT) {
    return res.status(400).json({ error: `count must be an integer between 1 and ${MAX_CROWD_COUNT}` });
  }

  const id = createJob('crowd');
  runCrowdJob(id, { count: n });
  res.status(202).json({ job_id: id, status_url: `/agent/crowd/${id}` });
});

router.get('/crowd/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.kind !== 'crowd') return res.status(404).json({ error: 'job not found' });

  if (job.status === 'processing') {
    return res.json({ status: 'processing', progress: job.progress ?? null });
  }
  if (job.status === 'error') {
    return res.status(job.isOffline ? 503 : 502).json({ status: 'error', error: job.error });
  }

  // Full per-member detail (prompt + ok/error) is inside the zip as
  // manifest.json — per-member prompts add up past typical HTTP header
  // size limits once count gets large. This header is just a quick glance.
  const okCount = (job.members ?? []).filter(m => m.ok).length;
  res.set('Content-Type', job.result.mimeType);
  res.set('Content-Disposition', `attachment; filename="${job.result.filename}"`);
  res.set('X-Crowd-Summary', `${okCount}/${(job.members ?? []).length} succeeded`);
  res.send(job.result.buffer);
});

export default router;
