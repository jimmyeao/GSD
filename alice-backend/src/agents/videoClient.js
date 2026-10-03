/**
 * Video generation client for ComfyUI.
 * All three modes (text-to-video, image-to-video, first/last-frame) run the
 * same MiniMax H3 graph (native ComfyUI support, merged 2026-08-03) via the
 * MiniMaxH3ImageToVideo node — first_frame/last_frame are simply omitted when
 * not needed. Output is generated natively at 1344x768 then resized to
 * exactly 1920x1080 with a plain lanczos resize (MiniMax's own 2K upscale
 * pass is hosted-API only, not part of the open-weight release).
 *
 * Deliberately NOT using a neural upscaler (RealESRGAN) here — measured at
 * ~573s (~9.5 min) for 294 frames on this hardware, on top of ~70+ min of
 * sampling, which is what pushed real jobs past a 90-minute timeout
 * (2026-08-09 incident). For a 1.43x resolution bump (1344x768→1920x1080)
 * that cost isn't worth it; lanczos resize is a few seconds.
 */

import { monitorProgress } from '../comfyProgress.js';
import { imageSize } from 'image-size';

/**
 * Read an image's real pixel dimensions from a base64 data URL — needed to
 * compute a correct crop box before it becomes an I2V first_frame/last_frame
 * (see computeCropBox below for why this matters).
 * @returns {{width: number, height: number}|null} null if dimensions can't be read.
 */
function getImageDimensionsFromDataUrl(dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:[\w/-]+;base64,/, '');
    const { width, height } = imageSize(Buffer.from(base64, 'base64'));
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Compute a crop box that brings an image to the exact target aspect ratio
 * before resizing — used ahead of MiniMax H3's first_frame/last_frame inputs,
 * which treat the image as a literal temporal anchor and don't correct a
 * mismatched aspect ratio themselves (a plain stretch-resize there produced
 * visibly distorted, inconsistent output — see buildH3Workflow).
 *
 * Cropping is anchored differently depending on which dimension needs
 * trimming: horizontal crops (image wider than target) are centered — safe,
 * since a person is usually centered left-right in frame. Vertical crops
 * (image narrower/taller than target — e.g. a square headshot against a
 * widescreen canvas) are anchored to the TOP, not centered: a center crop
 * trims equally off the top and bottom, and a real test showed that cut
 * into the top of the subject's head whenever the original photo's headroom
 * was smaller than the trim amount. Keeping the top and trimming the excess
 * off the bottom instead avoids that entirely — for a headshot/talking-head
 * photo, preserving the face matters far more than preserving the torso.
 */
function computeCropBox(imgWidth, imgHeight, targetWidth, targetHeight) {
  const targetAspect = targetWidth / targetHeight;
  const imgAspect = imgWidth / imgHeight;
  if (Math.abs(imgAspect - targetAspect) < 0.001) {
    return { x: 0, y: 0, width: imgWidth, height: imgHeight };
  }
  if (imgAspect > targetAspect) {
    // Wider than target — crop width, centered horizontally.
    const cropWidth = Math.round(imgHeight * targetAspect);
    return { x: Math.round((imgWidth - cropWidth) / 2), y: 0, width: cropWidth, height: imgHeight };
  }
  // Narrower/taller than target — crop height, anchored to the top.
  const cropHeight = Math.round(imgWidth / targetAspect);
  return { x: 0, y: 0, width: imgWidth, height: cropHeight };
}

/**
 * Resolve the crop box for an uploaded reference image, or null if its
 * dimensions couldn't be read (caller should fall back to a plain resize).
 */
function resolveCropBox(dataUrl, targetWidth, targetHeight) {
  const dims = getImageDimensionsFromDataUrl(dataUrl);
  if (!dims) return null;
  return computeCropBox(dims.width, dims.height, targetWidth, targetHeight);
}

/**
 * Infer the actual clip duration from a script's own "[Shot N] At
 * MM:SS.mmm" timestamps, instead of always rendering the fixed 12.25s
 * default regardless of what was written. Without this, a script that
 * (correctly) only describes e.g. 5 seconds of action for a short logo
 * reveal still got rendered at the full default length, leaving 7+ seconds
 * of the clip with zero scripted guidance — the model had nothing to work
 * from for the back half, a real contributor to underwhelming results
 * (2026-08-09 incident). Adds a small buffer past the last timestamp so
 * that shot's own action has room to play out, then the caller snaps to
 * H3's frame grid. Returns null if the text has no timestamps (e.g. a bare
 * prompt with no script), so callers fall back to the default duration.
 */
export function estimateDurationFromScript(text) {
  const matches = [...text.matchAll(/(\d{2}):(\d{2})\.(\d{1,3})/g)];
  if (matches.length === 0) return null;
  const lastSeconds = Math.max(...matches.map(([, mm, ss, ms]) =>
    Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000));
  return lastSeconds + 1.5; // let the final shot's action finish playing out
}

/**
 * Estimate how long a dialogue line needs to be spoken naturally, so a
 * chained clip's duration isn't a fixed guess that's too short for longer
 * lines. A real test used a fixed 8s budget and produced choppy, cut-off
 * audio — a 20-word line needs ~8s of speech on its own at a natural pace,
 * leaving zero slack for the walk-in/camera motion H3 also has to render in
 * that same window. ~2.5 words/second is a natural clear-speech pace; +2s
 * covers pacing/lead-in.
 *
 * Capped at 10s (not H3's full 15s) — a real 7-chunk test showed a ~14s
 * clip (needed for a long ~30-word line) drifted completely away from its
 * reference image partway through (a different, unrelated person/scene by
 * the time the clip actually started), while ~7-8s clips using the exact
 * same reference stayed faithful throughout. Longer generations apparently
 * give H3 more room to wander from the starting frame. Long lines now get
 * spoken faster than fully natural pace rather than risk that — prioritizing
 * staying on-reference over pacing.
 */
export function estimateDialogueDuration(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const speakingSeconds = words / 2.5;
  return Math.min(10, Math.max(6, speakingSeconds + 2));
}

/**
 * True if text already looks like a hand-written/VideoScriptAgent H3 script
 * (has the structured section headers or [Shot N] markers) rather than a
 * rough description. Used to skip H3-Promptor expansion so an already-correct
 * script doesn't get double-processed/mangled by a second LLM rewrite.
 */
export function looksLikeH3Script(text) {
  return /integrated_multimodal_description/i.test(text) || /\[Shot\s*\d+\]/i.test(text);
}

/**
 * True if text already looks like a hand-written/VideoScriptAgent LTX-2.5
 * script (has [VISUAL:]/[AUDIO:]/[VOICEOVER:] cue labels — see registry.js's
 * VideoScriptAgent "Format B: LTX-2.5") rather than a rough description. Used
 * to skip enhanceVideoPrompt so an already-correct script isn't rewritten.
 */
export function looksLikeLTXScript(text) {
  return /\[VISUAL:\]|\[AUDIO:\]|\[VOICEOVER:\]/i.test(text);
}

/**
 * Parse a "Chunk N — Title\nImage: filename\n\"dialogue text\"" script (the
 * format used for chained multi-clip generation) into ordered
 * `{ imageName, dialogue }` records. Title text is only used for chunk
 * identification, not passed to the model. Splits on chunk boundaries first
 * (tolerant of dash variants) rather than matching everything in one regex,
 * so `Image:` and the quoted dialogue can each be optional/on either line
 * without the two concerns interfering with each other:
 * - `imageName` is `null` when no `Image:` line is present (old-style
 *   scripts, or a chunk meant to chain from the previous one instead of
 *   cutting to a named shot).
 * - `dialogue` is `''` for a B-roll/cutaway chunk with empty quotes (`""`)
 *   — the old single regex used `+` not `*` and silently dropped these
 *   chunks entirely instead of matching an empty string.
 */
export function parseScriptChunks(script) {
  const blocks = script.split(/(?=Chunk\s*\d+\s*[-–—])/i).filter(b => /Chunk\s*\d+/i.test(b));
  return blocks.map(block => {
    // Stop at a quote character, not just end-of-line — a real script had
    // "Image: office reception.jpeg" and the dialogue's opening `""` on the
    // SAME line with no newline between them, and [^\r\n]+ swallowed the
    // trailing quotes into the filename itself.
    const imageMatch = block.match(/Image:\s*([^"“\r\n]+)/i);
    const dialogueMatch = block.match(/["“]([^"”]*)["”]/);
    return {
      imageName: imageMatch ? imageMatch[1].trim() : null,
      dialogue: dialogueMatch ? dialogueMatch[1].trim() : '',
    };
  });
}

/**
 * Upload a file (image or audio) to ComfyUI's input folder. ComfyUI's
 * `/upload/image` route is content-type agnostic server-side — it just
 * writes whatever bytes arrive in the "image" form field to the input
 * directory — so this same endpoint works for the audio reference clips
 * used by Ref2VA's LoadAudio nodes, not just images.
 * @param {string} endpoint - ComfyUI base URL
 * @param {string} dataUrl  - Base64 data URL (data:image/png;base64,... or data:audio/mpeg;base64,...)
 * @param {string} filename - Target filename
 * @returns {Promise<string>} The filename as stored by ComfyUI
 */
async function uploadMediaToComfy(endpoint, dataUrl, filename) {
  // Strip the data URL prefix to get raw base64 (any media type)
  const base64 = dataUrl.replace(/^data:[\w/-]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  // Build multipart form data manually
  const boundary = `----AliceUpload${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(`${endpoint}/upload/image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Media upload failed: ${res.status}`);
  const data = await res.json();
  console.log(`[videoClient] uploaded media: ${data.name}`);
  return data.name; // ComfyUI returns the stored filename
}

/**
 * Append H3_Promptor + PreviewAny nodes to an H3 node map, expanding a rough
 * description into MiniMax H3's structured prompt format via the local
 * alice-vision Ollama model (see ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Promptor).
 * PreviewAny is required because H3_Promptor itself has no OUTPUT_NODE flag —
 * without it, its STRING result never appears in ComfyUI's /history response,
 * so pollForVideo would have no way to read it back before the video finishes.
 * Fixed node ids 40/41 — unused by buildH3Workflow otherwise.
 * @returns {[string, number]} link to use as the downstream `prompt` input.
 */
function addH3PromptorNodes(nodes, description, taskTypeLabel, durationSeconds) {
  const promptorDuration = Math.min(15, Math.max(4, durationSeconds ?? 12.25));
  nodes['40'] = {
    class_type: 'H3_Promptor',
    inputs: {
      task_type: taskTypeLabel,
      description,
      duration: promptorDuration,
      output_language: 'English',
      provider: 'ollama (alice-vision)',
      temperature: 0.7,
      max_tokens: 4096,
    },
  };
  nodes['41'] = { class_type: 'PreviewAny', inputs: { source: ['40', 0] } };
  return ['40', 0];
}

/**
 * Shared output stage for both H3 workflows — identical from node '15'
 * onward in buildH3Workflow/buildH3ReferenceWorkflow, so it's factored out
 * rather than duplicated. Adds the optional 1080p upscale, video mux+save,
 * and (for chained multi-clip generation) an extracted last-frame image
 * output — grabbed via ImageFromBatch(batch_index=-1) + SaveImage, both real
 * ComfyUI core nodes (comfy_extras/nodes_images.py) — so the exact final
 * frame can be fed as the next clip's first_frame without needing ffmpeg (not
 * installed on this machine) to decode the finished mp4.
 * @param {[string, number]} rawImage  Link to the raw VAEDecode output ('11').
 * @param {[string, number]} audio     Link to the decoded audio output ('12').
 */
function addOutputStage(nodes, rawImage, audio, { fps, upscaleTo1080p, extractLastFrame, filenamePrefix }) {
  let finalImage = rawImage;
  if (upscaleTo1080p) {
    nodes['15'] = { class_type: 'ImageScale', inputs: { image: rawImage, upscale_method: 'lanczos', width: 1920, height: 1080, crop: 'disabled' } };
    finalImage = ['15', 0];
  }
  nodes['16'] = { class_type: 'CreateVideo', inputs: { images: finalImage, fps, audio, bit_depth: 8 } };
  nodes['17'] = { class_type: 'SaveVideo', inputs: { video: ['16', 0], filename_prefix: filenamePrefix, format: 'auto', codec: 'auto' } };

  if (extractLastFrame) {
    nodes['50'] = { class_type: 'ImageFromBatch', inputs: { image: finalImage, batch_index: -1, length: 1 } };
    nodes['51'] = { class_type: 'SaveImage', inputs: { images: ['50', 0], filename_prefix: 'alice_h3_lastframe' } };
  }
}

/**
 * Build a MiniMax H3 API workflow. Covers all three modes — text-to-video
 * (no images), image-to-video (firstFrameName only), and first/last-frame
 * (both) — since MiniMaxH3ImageToVideo takes first_frame/last_frame as
 * optional inputs that are simply omitted when a mode doesn't need them.
 * Mirrors /home/jimmy/ComfyUI/user/default/workflows/minimax_h3_*_1080p.json.
 *
 * @param {number} durationSeconds  Target clip length. H3 snaps duration to
 *   its 17-frame-per-block grid (frames = 17k+5) and caps at 15s per clip.
 * @param {number} width/height  Native generation resolution — H3's local
 *   cap is a 768px short edge (max ~1344x768 16:9). Final output is always
 *   upscaled to exactly 1920x1080 below regardless of this value, since
 *   MiniMax's own 2K upscale pass is hosted-API only.
 * @param {boolean} usePromptor  Run the prompt through H3_Promptor first (see
 *   addH3PromptorNodes) — skipped for already-structured H3 scripts.
 * @param {string} taskTypeLabel  H3_Promptor's task_type override, e.g.
 *   'Text-to-Video (T2V)' — only used when usePromptor is true.
 * @param {boolean} upscaleTo1080p  Default true; set false to skip the final
 *   resize and output at native width/height (faster to encode, used for
 *   quick low-res test runs — sampling cost is unaffected either way since
 *   that's driven by the native width/height above, not this pass).
 * @param {boolean} extractLastFrame  Also output the exact last frame as a
 *   separate image (for chaining into the next clip's first_frame).
 * @param {number} steps  KSampler steps, default 20. Lower (e.g. 8-10) for
 *   fast/rough test runs — roughly proportional to sampling time.
 * @param {number} seed  Optional fixed seed override — random if omitted.
 *   H3 is a joint audio-video diffusion model (model_type FLOW_AV), so voice/
 *   timbre selection is tied to this same seed as the visual noise pattern;
 *   chained generation reuses one fixed seed across every clip so H3's own
 *   default voice stays consistent instead of re-rolling per chunk.
 */
function buildH3Workflow(prompt, { firstFrameName, lastFrameName, firstFrameCropBox, lastFrameCropBox, durationSeconds = 12.25, width = 1344, height = 768, usePromptor = false, taskTypeLabel = 'Text-to-Video (T2V)', upscaleTo1080p = true, extractLastFrame = false, steps = 20, seed = Math.floor(Math.random() * 2 ** 32) } = {}) {
  const fps = 24;
  // Clamp to H3's documented trained range (124-362 frames, k=7..21) — the
  // node accepts k=0 (5 frames) but that's untested/unsupported territory.
  const k = Math.min(21, Math.max(7, Math.round((Math.round(durationSeconds * fps) - 5) / 17)));
  const length = 17 * k + 5;

  const imageToVideoInputs = { clip: ['2', 0], vae: ['3', 0], prompt, width, height, length };
  const nodes = {
    // ── Model loading ───────────────────────────────────────────
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },

    // ── Conditioning + sampling ──────────────────────────────────
    '5': { class_type: 'MiniMaxH3ImageToVideo', inputs: imageToVideoInputs },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '8': { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: 'simple', steps, denoise: 1 } },
    '9': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
    '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] } },

    // ── Decode ────────────────────────────────────────────────────
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 1], vae: ['4', 0] } },
  };
  addOutputStage(nodes, ['11', 0], ['12', 0], { fps, upscaleTo1080p, extractLastFrame, filenamePrefix: 'alice_h3_video' });

  // first_frame/last_frame are treated by H3 as literal temporal anchors —
  // unlike Ref2VA's reference images (which H3 may crop/recompose itself),
  // a mismatched aspect ratio here isn't corrected gracefully. A real test
  // with a square (1024x1024) photo against a 640x384 widescreen canvas
  // showed inconsistent stretching, occasional missing background, and
  // appearance drift between separate chunks reusing the same photo —
  // confirmed via research (MiniMax H3 reference-media guide: "use the
  // target video's aspect ratio whenever possible" for first_frame/keyframe
  // images specifically). Explicitly crop to the exact generation aspect
  // ratio before it ever reaches MiniMaxH3ImageToVideo (via ImageCrop, using
  // a caller-computed box — see computeCropBox — rather than ImageScale's
  // own center-crop: a plain center crop trimmed equally off the top and
  // bottom, which cut into the top of the subject's head on a square photo
  // with little headroom; ImageCrop lets that trim be top-anchored instead).
  if (firstFrameName) {
    nodes['18'] = { class_type: 'LoadImage', inputs: { image: firstFrameName } };
    let imgLink = ['18', 0];
    if (firstFrameCropBox) {
      nodes['62'] = { class_type: 'ImageCrop', inputs: { image: imgLink, ...firstFrameCropBox } };
      imgLink = ['62', 0];
    }
    nodes['60'] = { class_type: 'ImageScale', inputs: { image: imgLink, upscale_method: 'lanczos', width, height, crop: 'disabled' } };
    imageToVideoInputs.first_frame = ['60', 0];
  }
  if (lastFrameName) {
    nodes['19'] = { class_type: 'LoadImage', inputs: { image: lastFrameName } };
    let imgLink = ['19', 0];
    if (lastFrameCropBox) {
      nodes['63'] = { class_type: 'ImageCrop', inputs: { image: imgLink, ...lastFrameCropBox } };
      imgLink = ['63', 0];
    }
    nodes['61'] = { class_type: 'ImageScale', inputs: { image: imgLink, upscale_method: 'lanczos', width, height, crop: 'disabled' } };
    imageToVideoInputs.last_frame = ['61', 0];
  }

  if (usePromptor) {
    imageToVideoInputs.prompt = addH3PromptorNodes(nodes, prompt, taskTypeLabel, durationSeconds);
  }

  return nodes;
}

/**
 * Build a MiniMax H3 reference-to-video (Ref2VA) API workflow: character
 * identity, style, and audio-texture references instead of exact keyframes.
 * Uses H3's separate ref2va checkpoint and the MiniMaxH3ReferenceToVideo
 * node — its ref_image_N/ref_audio_N inputs are "autogrow" slots (0-indexed
 * in the graph, but referenced as 1-based <Picture i>/<Audio j> tags in the
 * prompt text — the node itself has no notion of what each reference
 * "means"; that's conveyed entirely by the prompt, which is why
 * composeRef2VAPrompt exists).
 * @param {string[]} refImageNames  Filenames already uploaded to ComfyUI, max 9.
 * @param {string[]} refAudioNames  Filenames already uploaded to ComfyUI, max 3.
 * @param {boolean} usePromptor  Run the prompt through H3_Promptor first (see
 *   addH3PromptorNodes). Trusted for Ref2VA as of the voice-reference feature —
 *   the plugin's own system_base.txt documents handling <Picture N>/<Audio N>
 *   tags as part of its "ensemble cast" concept and lists Ref2VA as a real
 *   supported task type.
 * @param {string} taskTypeLabel  Defaults to Ref2VA's own H3_Promptor label.
 * @param {number} seed  Optional fixed seed override — random if omitted (see buildH3Workflow).
 */
function buildH3ReferenceWorkflow(prompt, { refImageNames = [], refAudioNames = [], durationSeconds = 12.25, width = 1344, height = 768, upscaleTo1080p = true, extractLastFrame = false, usePromptor = false, taskTypeLabel = 'Reference-to-Video-Audio (Ref2VA)', steps = 20, seed = Math.floor(Math.random() * 2 ** 32) } = {}) {
  if (refImageNames.length > 9) throw new Error(`Ref2VA supports at most 9 reference images (got ${refImageNames.length})`);
  if (refAudioNames.length > 3) throw new Error(`Ref2VA supports at most 3 reference audio clips (got ${refAudioNames.length})`);

  const fps = 24;
  // Clamp to H3's documented trained range (124-362 frames, k=7..21) — the
  // node accepts k=0 (5 frames) but that's untested/unsupported territory.
  const k = Math.min(21, Math.max(7, Math.round((Math.round(durationSeconds * fps) - 5) / 17)));
  const length = 17 * k + 5;

  const referenceInputs = {
    clip: ['2', 0], vae: ['3', 0], audio_vae: ['4', 0], prompt, width, height, length,
    ref_image_size: 'match',
  };
  const nodes = {
    // ── Model loading ───────────────────────────────────────────
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },

    // ── Conditioning + sampling ──────────────────────────────────
    '5': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: referenceInputs },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '8': { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: 'simple', steps, denoise: 1 } },
    '9': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
    '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] } },

    // ── Decode ────────────────────────────────────────────────────
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 1], vae: ['4', 0] } },
  };
  addOutputStage(nodes, ['11', 0], ['12', 0], { fps, upscaleTo1080p, extractLastFrame, filenamePrefix: 'alice_h3_ref2va' });

  // Autogrow slots are namespaced under the parent field's own id, joined
  // with ".": ComfyUI's dynamic-input resolver expects "ref_images.ref_image_0",
  // not a flat "ref_image_0" (confirmed against comfy_api/latest/_io.py's
  // parse_class_inputs/finalize_prefix — a flat key raises "unexpected keyword
  // argument" since it never matches a registered dynamic_paths entry).
  let nextId = 18;
  refImageNames.forEach((name, i) => {
    const id = String(nextId++);
    nodes[id] = { class_type: 'LoadImage', inputs: { image: name } };
    referenceInputs[`ref_images.ref_image_${i}`] = [id, 0];
  });
  refAudioNames.forEach((name, i) => {
    const id = String(nextId++);
    nodes[id] = { class_type: 'LoadAudio', inputs: { audio: name } };
    referenceInputs[`ref_audios.ref_audio_${i}`] = [id, 0];
  });

  if (usePromptor) {
    referenceInputs.prompt = addH3PromptorNodes(nodes, prompt, taskTypeLabel, durationSeconds);
  }

  return nodes;
}

/**
 * Build the final Ref2VA prompt by prepending an auto-generated reference
 * key ("<Picture 1> = ...") so the user never has to learn H3's tag syntax
 * themselves — they just type a plain description and optionally label
 * each attachment. Skips the key line entirely if nothing was labeled.
 * @param {string} userPrompt
 * @param {{ label?: string, kind: 'image'|'audio' }[]} refs  In upload order —
 *   must match the order refImageNames/refAudioNames were passed to
 *   buildH3ReferenceWorkflow (images and audio are numbered independently).
 */
export function composeRef2VAPrompt(userPrompt, refs) {
  let imageOrdinal = 0;
  let audioOrdinal = 0;
  const parts = refs
    .map((ref) => {
      const ordinal = ref.kind === 'audio' ? ++audioOrdinal : ++imageOrdinal;
      const tag = ref.kind === 'audio' ? `<Audio ${ordinal}>` : `<Picture ${ordinal}>`;
      return ref.label ? `${tag} = ${ref.label}` : null;
    })
    .filter(Boolean);

  if (parts.length === 0) return userPrompt;
  return `Reference media: ${parts.join('. ')}.\n\n${userPrompt}`;
}

// Model filenames for the LTX-2.5 migration (2026-09-09) — downloaded per
// the official "Text to Video (LTX-2.5)"/"Image to Video (LTX-2.5)"/
// "First & Last Frame to Video (LTX-2.5)" ComfyUI blueprints. The diffusion
// model is ALREADY the distilled checkpoint (unlike 2.3, which needed a
// separate LoraLoaderModelOnly distillation LoRA stacked on a base dev
// checkpoint) — one less node, and LTXVDualCFGGuider (separate video_cfg/
// audio_cfg, since 2.5's AV latent is jointly denoised, same idea as
// MiniMax H3) replaces the old single-value CFGGuider.
const LTX25_UNET = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const LTX25_CLIP = 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors';
const LTX25_VIDEO_VAE = 'ltx-2.5-video-vae-bf16.safetensors';
const LTX25_AUDIO_VAE = 'ltx-2.5-audio-vae-bf16.safetensors';
const LTX25_UPSCALER = 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors';

/**
 * Build a LTX-2.5 API workflow covering both text-to-video (no image) and
 * image-to-video (one image) — same two-pass distilled pipeline shape as
 * the prior LTX-2.5 implementation (8-step half-res sample → latent
 * upscale → 4-step full-res refine, T2V bypassing image-conditioning via
 * an EmptyImage placeholder through LTXVImgToVideoInplace's `bypass` flag),
 * rebuilt node-for-node against the official "Text to Video (LTX-2.5)" /
 * "Image to Video (LTX-2.5)" ComfyUI blueprints (2026-09-09 migration).
 *
 * @param {number} durationSeconds  Clip length. LTX frame counts are
 *   24fps*seconds+1 (no grid constraint like H3's 17k+5).
 * @param {number} width/height  Native generation resolution (pre-upscale
 *   pass runs at exactly half this). Output is resized to exactly 1920x1080
 *   below with a plain lanczos resize — LTX's native output otherwise stays
 *   at whatever width/height is passed in (default 1280x720).
 */
function buildLTXWorkflow(prompt, { firstFrameName, durationSeconds = 12, width = 1280, height = 720, extractLastFrame = false } = {}) {
  const seed1 = Math.floor(Math.random() * 2 ** 32);
  const seed2 = Math.floor(Math.random() * 2 ** 32);
  const fps = 24;
  const frames = Math.round(durationSeconds * fps) + 1;
  const latentW = Math.round(width / 2);
  const latentH = Math.round(height / 2);
  const isI2V = !!firstFrameName;

  const nodes = {
    // ── Model loading ───────────────────────────────────────────
    '1': { class_type: 'UNETLoader', inputs: { unet_name: LTX25_UNET, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: LTX25_CLIP, type: 'ltxv', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: LTX25_VIDEO_VAE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: LTX25_AUDIO_VAE } },
    '5': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: LTX25_UPSCALER } },

    // ── Text encoding ───────────────────────────────────────────
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: isI2V
          ? 'pc game, console game, video game, cartoon, childish, ugly, static scene, motionless subjects, walking in place, treadmill motion, frozen people, stationary pedestrians, no displacement'
          : 'blurry, low quality, watermark, text overlay, still frame, static scene, motionless subjects, walking in place, treadmill motion, frozen people, stationary pedestrians',
        clip: ['2', 0],
      },
    },
    '8': { class_type: 'LTXVConditioning', inputs: { positive: ['6', 0], negative: ['7', 0], frame_rate: fps } },

    // ── Image loading + preprocessing (I2V) / bypass placeholder (T2V) ──
    ...(isI2V
      ? {
          '9': { class_type: 'LoadImage', inputs: { image: firstFrameName } },
          '10': { class_type: 'ResizeImageMaskNode', inputs: { input: ['9', 0], resize_type: 'scale longer dimension', 'resize_type.longer_size': 1536, scale_method: 'lanczos' } },
          '11': { class_type: 'LTXVPreprocess', inputs: { image: ['10', 0], img_compression: 18 } },
        }
      : {
          '9': { class_type: 'EmptyImage', inputs: { width: latentW, height: latentH, batch_size: 1, color: 0 } },
        }),

    // ── Pass 1: initial latent + image injection at 0.7 (bypassed for T2V) ──
    '12': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: latentW, height: latentH, length: frames, batch_size: 1 } },
    '13': { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['4', 0], frames_number: frames, frame_rate: fps, batch_size: 1 } },
    '14': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['3', 0], image: isI2V ? ['11', 0] : ['9', 0], latent: ['12', 0], strength: 0.7, bypass: !isI2V } },
    '15': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['14', 0], audio_latent: ['13', 0] } },

    // ── Pass 1: 8-step distilled sampling ────────────────────────
    '16': { class_type: 'LTXVDualCFGGuider', inputs: { model: ['1', 0], positive: ['8', 0], negative: ['8', 1], video_cfg: 1, audio_cfg: 1 } },
    '17': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    '18': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    '19': { class_type: 'RandomNoise', inputs: { noise_seed: seed1 } },
    '20': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['19', 0], guider: ['16', 0], sampler: ['17', 0], sigmas: ['18', 0], latent_image: ['15', 0] } },
    '21': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['20', 0] } },

    // ── Latent upscale + image re-inject at 1.0 (I2V only) ──────
    '22': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['21', 0], upscale_model: ['5', 0], vae: ['3', 0] } },
    '23': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['3', 0], image: isI2V ? ['11', 0] : ['9', 0], latent: ['22', 0], strength: 1.0, bypass: !isI2V } },
    '24': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['23', 0], audio_latent: ['21', 1] } },

    // ── Pass 2: 3-step refinement ────────────────────────────────
    '25': { class_type: 'LTXVDualCFGGuider', inputs: { model: ['1', 0], positive: ['8', 0], negative: ['8', 1], video_cfg: 1, audio_cfg: 1 } },
    '26': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    '27': { class_type: 'ManualSigmas', inputs: { sigmas: '0.85, 0.7250, 0.4219, 0.0' } },
    '28': { class_type: 'RandomNoise', inputs: { noise_seed: seed2 } },
    '29': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['28', 0], guider: ['25', 0], sampler: ['26', 0], sigmas: ['27', 0], latent_image: ['24', 0] } },
    '30': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['29', 0] } },

    // ── Decode (tile params match the official 2.5 blueprint exactly) ──
    '31': { class_type: 'VAEDecodeTiled', inputs: { samples: ['30', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    '32': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['30', 1], audio_vae: ['4', 0] } },

    // ── Resize to exact 1920x1080 (plain lanczos, same rationale as H3) ──
    '33': { class_type: 'ImageScale', inputs: { image: ['31', 0], upscale_method: 'lanczos', width: 1920, height: 1080, crop: 'disabled' } },

    // ── Mux + save ───────────────────────────────────────────────
    '34': { class_type: 'CreateVideo', inputs: { images: ['33', 0], audio: ['32', 0], fps } },
    '35': { class_type: 'SaveVideo', inputs: { video: ['34', 0], filename_prefix: isI2V ? 'alice_ltx_i2v' : 'alice_ltx_video', format: 'mp4', codec: 'h264' } },
  };

  // ── Extract exact last frame for chaining (mirrors H3's addOutputStage —
  // see buildH3Workflow) — off the post-resize node '33' so the extracted
  // frame matches the video's actual displayed resolution/output, not the
  // pre-resize native canvas.
  if (extractLastFrame) {
    nodes['36'] = { class_type: 'ImageFromBatch', inputs: { image: ['33', 0], batch_index: -1, length: 1 } };
    nodes['37'] = { class_type: 'SaveImage', inputs: { images: ['36', 0], filename_prefix: 'alice_ltx_lastframe' } };
  }

  return nodes;
}

/**
 * Build a LTX-2.5 first/last-frame API workflow. Genuinely different graph
 * from buildLTXWorkflow's I2V mode — not a variant of the 2-pass pipeline.
 * Rebuilt against the official "First & Last Frame to Video (LTX-2.5)"
 * blueprint (2026-09-09 migration) — confirmed via full node-type inventory
 * that this template, like its 2.3 predecessor, has no upscale/refine second
 * pass (no LTXVLatentUpsampler/LatentUpscaleModelLoader present anywhere in
 * it). Same `LTXVAddGuide` chain-then-`LTXVCropGuides` shape as before —
 * first_frame at frame_idx=0, then last_frame at frame_idx=-1, with
 * positive/negative/latent all threaded through both calls (the guide
 * bookkeeping lives in the conditioning, not just the latent — skipping the
 * chain silently loses the first guide) — now over the joint AV latent
 * (LTXVConcatAVLatent/SeparateAVLatent) with LTXVDualCFGGuider, matching the
 * T2V/I2V pipeline's audio-video-joint approach. The distilled UNET is used
 * directly (no separate distillation LoRA needed, see LTX25_UNET).
 */
function buildLTXFirstLastFrameWorkflow(prompt, { firstFrameName, lastFrameName, durationSeconds = 12, width = 1280, height = 720, extractLastFrame = false } = {}) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const fps = 24;
  const frames = Math.round(durationSeconds * fps) + 1;

  const nodes = {
    // ── Model loading ───────────────────────────────────────────
    '1': { class_type: 'UNETLoader', inputs: { unet_name: LTX25_UNET, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: LTX25_CLIP, type: 'ltxv', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: LTX25_VIDEO_VAE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: LTX25_AUDIO_VAE } },

    // ── Text encoding ───────────────────────────────────────────
    '5': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, watermark, text overlay, static scene, motionless subjects, walking in place, treadmill motion, frozen people, stationary pedestrians', clip: ['2', 0] } },
    '7': { class_type: 'LTXVConditioning', inputs: { positive: ['5', 0], negative: ['6', 0], frame_rate: fps } },

    // ── Guide images: crop-to-fit (preserves aspect, avoids the H3-style
    //    stretch/squash distortion a plain disabled-crop resize causes) ──
    '8': { class_type: 'LoadImage', inputs: { image: firstFrameName } },
    '9': { class_type: 'ResizeImageMaskNode', inputs: { input: ['8', 0], resize_type: 'scale dimensions', 'resize_type.width': width, 'resize_type.height': height, 'resize_type.crop': 'center', scale_method: 'lanczos' } },
    '10': { class_type: 'LoadImage', inputs: { image: lastFrameName } },
    '11': { class_type: 'ResizeImageMaskNode', inputs: { input: ['10', 0], resize_type: 'scale dimensions', 'resize_type.width': width, 'resize_type.height': height, 'resize_type.crop': 'center', scale_method: 'lanczos' } },

    // ── Empty latent + audio latent ──────────────────────────────
    '12': { class_type: 'EmptyLTXVLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
    '13': { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['4', 0], frames_number: frames, frame_rate: fps, batch_size: 1 } },

    // ── Add first-frame guide (frame_idx=0), then chain last-frame
    //    guide (frame_idx=-1) off its outputs — order matters, see header ──
    '14': { class_type: 'LTXVAddGuide', inputs: { positive: ['7', 0], negative: ['7', 1], vae: ['3', 0], latent: ['12', 0], image: ['9', 0], frame_idx: 0, strength: 0.7 } },
    '15': { class_type: 'LTXVAddGuide', inputs: { positive: ['14', 0], negative: ['14', 1], vae: ['3', 0], latent: ['14', 2], image: ['11', 0], frame_idx: -1, strength: 0.7 } },
    '16': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['15', 2], audio_latent: ['13', 0] } },

    // ── Single-pass 8-step distilled sampling (no upscale/refine — matches official template) ──
    '17': { class_type: 'LTXVDualCFGGuider', inputs: { model: ['1', 0], positive: ['15', 0], negative: ['15', 1], video_cfg: 1, audio_cfg: 1 } },
    '18': { class_type: 'SamplerEulerAncestral', inputs: { eta: 0, s_noise: 1 } },
    '19': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    '20': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '21': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['20', 0], guider: ['17', 0], sampler: ['18', 0], sigmas: ['19', 0], latent_image: ['16', 0] } },
    '22': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['21', 0] } },

    // ── Crop the two appended guide frames back off the video latent only
    //    (guides are a video-only concept — audio latent is untouched) ──
    '23': { class_type: 'LTXVCropGuides', inputs: { positive: ['15', 0], negative: ['15', 1], latent: ['22', 0] } },

    // ── Decode (tile params match the official 2.5 blueprint exactly) ──
    '24': { class_type: 'VAEDecodeTiled', inputs: { samples: ['23', 2], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    '25': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['22', 1], audio_vae: ['4', 0] } },

    // ── Resize to exact 1920x1080 ────────────────────────────────
    '26': { class_type: 'ImageScale', inputs: { image: ['24', 0], upscale_method: 'lanczos', width: 1920, height: 1080, crop: 'disabled' } },

    // ── Mux + save ───────────────────────────────────────────────
    '27': { class_type: 'CreateVideo', inputs: { images: ['26', 0], audio: ['25', 0], fps } },
    '28': { class_type: 'SaveVideo', inputs: { video: ['27', 0], filename_prefix: 'alice_ltx_fl2v', format: 'mp4', codec: 'h264' } },
  };

  // ── Extract exact last frame for chaining — same node ids (36/37) as
  // buildLTXWorkflow's, off the post-resize node '26' here, so pollForVideo's
  // single fallback check covers every LTX workflow uniformly.
  if (extractLastFrame) {
    nodes['36'] = { class_type: 'ImageFromBatch', inputs: { image: ['26', 0], batch_index: -1, length: 1 } };
    nodes['37'] = { class_type: 'SaveImage', inputs: { images: ['36', 0], filename_prefix: 'alice_ltx_lastframe' } };
  }

  return nodes;
}

/**
 * Poll ComfyUI history for video output.
 * When found, immediately downloads and caches the video locally
 * (so ComfyUI can be safely killed after this returns).
 */
async function pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, onPromptExpanded) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const videosDir = join(__dir, '..', '..', 'data', 'videos');
  mkdirSync(videosDir, { recursive: true });

  // Start WebSocket progress monitor. Prompt-expansion readback (node '41',
  // PreviewAny) must come from the 'executed' websocket event, not /history
  // polling below — ComfyUI only adds a /history entry once the *entire*
  // prompt finishes, so by the time it'd show up there the video is already
  // done too, defeating the point of an early readback.
  let promptReported = false;
  const reportPromptOnce = (text) => {
    if (!promptReported && onPromptExpanded) {
      promptReported = true;
      onPromptExpanded(text);
    }
  };
  const onNodeExecuted = (nodeId, output) => {
    if (nodeId === '41' && output?.text?.length) reportPromptOnce(output.text[0]);
  };
  const stopMonitor = (onProgress || onPromptExpanded)
    ? monitorProgress(endpoint, clientId, promptId, onProgress || (() => {}), onNodeExecuted)
    : () => {};

  const deadline = Date.now() + timeoutMs;
  try {
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));

    let histRes;
    try {
      histRes = await fetch(`${endpoint}/history/${promptId}`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch { continue; } // ComfyUI might be busy, retry
    if (!histRes.ok) continue;

    const history = await histRes.json();
    const entry = history[promptId];
    if (!entry) continue;

    if (entry.status?.status_str === 'error') {
      const msgs = entry.status?.messages || [];
      const errMsg = msgs.find(m => m[0] === 'execution_error');
      throw new Error(errMsg ? JSON.stringify(errMsg[1]).slice(0, 300) : 'ComfyUI execution error');
    }

    const outputs = entry.outputs || {};

    // Fallback in case the websocket 'executed' event above was missed
    // (e.g. a brief reconnect gap) — by the time this fires via /history the
    // whole prompt (including the video) is done, but better late than never.
    if (outputs['41']?.text?.length) reportPromptOnce(outputs['41'].text[0]);

    for (const nodeId of Object.keys(outputs)) {
      const nodeOut = outputs[nodeId];
      if (nodeOut.images?.length && nodeOut.animated?.[0] === true) {
        const vid = nodeOut.images[0];
        console.log(`[videoClient] video generated: ${vid.filename}`);

        // Immediately cache locally before returning (so ComfyUI can be killed safely)
        try {
          const viewUrl = `${endpoint}/view?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder || '')}&type=${encodeURIComponent(vid.type || 'output')}`;
          const vidRes = await fetch(viewUrl, { signal: AbortSignal.timeout(120_000) });
          if (vidRes.ok) {
            writeFileSync(join(videosDir, vid.filename), Buffer.from(await vidRes.arrayBuffer()));
            console.log(`[videoClient] cached locally: ${vid.filename}`);
          }
        } catch (e) {
          console.warn(`[videoClient] failed to cache: ${e.message}`);
        }

        const result = {
          filename: vid.filename,
          subfolder: vid.subfolder || '',
          type: vid.type || 'output',
        };

        // Extracted last frame (node '51' for H3 — see addOutputStage — or
        // '37' for LTX — see buildLTXWorkflow/buildLTXFirstLastFrameWorkflow)
        // for chained generation: download it now and hand back a ready-to-
        // upload {name, dataUrl} in the same shape generateI2V's imageData
        // param already expects, so the caller can chain straight into the
        // next clip without any extra ffmpeg/video-decode step.
        const frameOut = outputs['51'] ?? outputs['37'];
        if (frameOut?.images?.length) {
          const frame = frameOut.images[0];
          try {
            const frameUrl = `${endpoint}/view?filename=${encodeURIComponent(frame.filename)}&subfolder=${encodeURIComponent(frame.subfolder || '')}&type=${encodeURIComponent(frame.type || 'output')}`;
            const frameRes = await fetch(frameUrl, { signal: AbortSignal.timeout(30_000) });
            if (frameRes.ok) {
              const b64 = Buffer.from(await frameRes.arrayBuffer()).toString('base64');
              result.lastFrame = { name: frame.filename, dataUrl: `data:image/png;base64,${b64}` };
            }
          } catch (e) {
            console.warn(`[videoClient] failed to fetch extracted last frame: ${e.message}`);
          }
        }

        return result;
      }
    }
  }

  throw new Error('Video generation timed out');
  } finally {
    stopMonitor();
  }
}

async function queueWorkflow(endpoint, workflow, clientId) {
  const queueRes = await fetch(`${endpoint}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!queueRes.ok) {
    const text = await queueRes.text();
    throw new Error(`ComfyUI queue failed (${queueRes.status}): ${text.slice(0, 200)}`);
  }

  const { prompt_id } = await queueRes.json();
  return prompt_id;
}

/**
 * Generate a text-to-video.
 * @param {number} durationSeconds  Clip length, default 12.25s (H3's 17k+5 grid; 15s hard cap).
 * @param {number} width/height     Native generation resolution, default 1344x768 (H3's local
 *   cap); output is always upscaled to exactly 1920x1080 regardless of this value.
 */
export async function generateVideo(endpoint, prompt, timeoutMs = 300_000, durationSeconds = 12.25, width = 1344, height = 768, onProgress, usePromptor = false, taskTypeLabel = 'Text-to-Video (T2V)', onPromptExpanded) {
  const clientId = `alice-video-${Date.now()}`;
  const workflow = buildH3Workflow(prompt, { durationSeconds, width, height, usePromptor, taskTypeLabel });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] t2v queued: ${promptId}`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, onPromptExpanded);
}

/**
 * Generate an image-to-video (animates forward from an exact first frame).
 * @param {string} endpoint  - ComfyUI URL
 * @param {string} prompt    - Text prompt describing the video motion
 * @param {object} imageData - { name: string, dataUrl: string } base64 image
 * @param {number} timeoutMs - Timeout
 * @param {number} durationSeconds/width/height - See generateVideo.
 */
export async function generateI2V(endpoint, prompt, imageData, timeoutMs = 300_000, durationSeconds = 12.25, width = 1344, height = 768, onProgress, usePromptor = false, taskTypeLabel = 'Image-to-Video (I2V)', onPromptExpanded, upscaleTo1080p = true, extractLastFrame = false, steps = 20, seed) {
  const clientId = `alice-i2v-${Date.now()}`;
  const firstFrameName = await uploadMediaToComfy(endpoint, imageData.dataUrl, imageData.name);
  const firstFrameCropBox = resolveCropBox(imageData.dataUrl, width, height);
  const workflow = buildH3Workflow(prompt, { firstFrameName, firstFrameCropBox, durationSeconds, width, height, usePromptor, taskTypeLabel, upscaleTo1080p, extractLastFrame, steps, ...(seed !== undefined ? { seed } : {}) });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] i2v queued: ${promptId} (first frame: ${firstFrameName})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, onPromptExpanded);
}

/**
 * Generate a first/last-frame video (H3 generates the motion connecting two exact keyframes).
 * @param {string} endpoint        - ComfyUI URL
 * @param {string} prompt          - Text prompt describing the motion between the two frames
 * @param {object} firstImageData  - { name: string, dataUrl: string } base64 image
 * @param {object} lastImageData   - { name: string, dataUrl: string } base64 image
 * @param {number} timeoutMs       - Timeout
 * @param {number} durationSeconds/width/height - See generateVideo.
 */
export async function generateFL2V(endpoint, prompt, firstImageData, lastImageData, timeoutMs = 300_000, durationSeconds = 12.25, width = 1344, height = 768, onProgress, usePromptor = false, taskTypeLabel = 'First-and-Last-Frame-to-Video (FL2VA)', onPromptExpanded, upscaleTo1080p = true, extractLastFrame = false, steps = 20, seed) {
  const clientId = `alice-fl2v-${Date.now()}`;
  const sameImage = firstImageData === lastImageData;
  const firstFrameName = await uploadMediaToComfy(endpoint, firstImageData.dataUrl, firstImageData.name);
  const lastFrameName = sameImage ? firstFrameName : await uploadMediaToComfy(endpoint, lastImageData.dataUrl, lastImageData.name);
  const firstFrameCropBox = resolveCropBox(firstImageData.dataUrl, width, height);
  const lastFrameCropBox = sameImage ? firstFrameCropBox : resolveCropBox(lastImageData.dataUrl, width, height);
  const workflow = buildH3Workflow(prompt, { firstFrameName, lastFrameName, firstFrameCropBox, lastFrameCropBox, durationSeconds, width, height, usePromptor, taskTypeLabel, upscaleTo1080p, extractLastFrame, steps, ...(seed !== undefined ? { seed } : {}) });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] fl2v queued: ${promptId} (first: ${firstFrameName}, last: ${lastFrameName})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, onPromptExpanded);
}

/**
 * Generate a reference-based video: character identity, style, and/or audio
 * references instead of exact keyframes. The numbering the model actually
 * sees (<Picture i>/<Audio j>) is derived purely from array order, so
 * refImages/refAudios must be passed in the order the user attached them.
 * @param {string} endpoint     - ComfyUI URL
 * @param {string} prompt       - Plain-language description; composeRef2VAPrompt
 *   has already prepended the reference key by the time this is called.
 * @param {{name: string, dataUrl: string}[]} refImages  Up to 9.
 * @param {{name: string, dataUrl: string}[]} refAudios  Up to 3.
 * @param {number} timeoutMs
 * @param {number} durationSeconds/width/height - See generateVideo.
 */
export async function generateRef2V(endpoint, prompt, refImages = [], refAudios = [], timeoutMs = 300_000, durationSeconds = 12.25, width = 1344, height = 768, onProgress, upscaleTo1080p = true, extractLastFrame = false, usePromptor = false, taskTypeLabel = 'Reference-to-Video-Audio (Ref2VA)', onPromptExpanded, steps = 20, seed) {
  const clientId = `alice-ref2va-${Date.now()}`;
  const refImageNames = [];
  for (const img of refImages) refImageNames.push(await uploadMediaToComfy(endpoint, img.dataUrl, img.name));
  const refAudioNames = [];
  for (const audio of refAudios) refAudioNames.push(await uploadMediaToComfy(endpoint, audio.dataUrl, audio.name));

  const workflow = buildH3ReferenceWorkflow(prompt, { refImageNames, refAudioNames, durationSeconds, width, height, upscaleTo1080p, extractLastFrame, usePromptor, taskTypeLabel, steps, ...(seed !== undefined ? { seed } : {}) });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] ref2va queued: ${promptId} (images: ${refImageNames.join(', ')}; audio: ${refAudioNames.join(', ')})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, onPromptExpanded);
}

/**
 * Orchestrate a chained multi-clip H3 generation. Every chunk runs a
 * two-stage pipeline instead of plain I2V:
 *
 * Stage A ("establish") — a short, cheap Ref2VA (`MiniMaxH3ReferenceToVideo`)
 * pass using the chunk's resolved image as a *soft* reference, with a static
 * establishing prompt (no dialogue). Ref2VA is explicitly designed to work
 * from imperfect reference material — it may crop/recompose — so it commits
 * to one concrete, natural-looking scene (background, framing) from
 * whatever source image it's given, including ones that are a poor literal
 * first frame (a plain studio headshot with no environment, or a static UI
 * screenshot). Only its extracted *last frame* is kept.
 *
 * Stage B ("hold") — the real clip (dialogue or ambient B-roll), generated
 * as FL2V (`first_frame` = `last_frame` = Stage A's established frame,
 * i.e. pinned to the *same* image at both ends). Frame-by-frame inspection
 * of an earlier I2V-only version showed H3 only holds the literal first
 * frame for a handful of frames (<0.3s) before free-running on text
 * conditioning alone — for dialogue about IT/office topics this reliably
 * snapped to a generic corporate-stock-footage office, discarding the
 * actual reference image's background entirely. Pinning *both* ends to the
 * same frame forces H3 to solve the whole clip as an interpolation between
 * two identical anchors instead of free-running after the first instant.
 *
 * This replaces the original chunk-0-only Ref2VA design (a random headshot
 * doesn't look like "mid-stride in an office," so Ref2VA let the model
 * reinterpret it into a natural establishing shot) — the same reasoning
 * turned out to apply to every chunk, not just the first: named images
 * (`Image: X` — see parseScriptChunks) still need a soft establishing pass
 * before they're reliable as a *held* anchor for the whole clip duration.
 *
 * Each chunk resolves its own source image in priority order:
 * 1. Named (`Image: X`, case/whitespace-insensitive lookup among attached
 *    reference images) — a fresh cut to that shot, independent of whatever
 *    came before.
 * 2. Unnamed, but a previous chunk produced a last frame — chain from it
 *    (today's original behavior, for chunks meant to continue a take).
 * 3. Unnamed, no previous frame (chunk 1 with no `Image:` line) — fall back
 *    to the single attached reference image if exactly one was attached
 *    (keeps old single-photo scripts working unchanged); ambiguous
 *    otherwise (0 or 2+ images with nothing to disambiguate) — clear error.
 *
 * Dialogue is optional per chunk (`''` = silent B-roll/cutaway — see
 * parseScriptChunks) and picks a different prompt template: no dialogue tag,
 * no person-facing camera language, just the environment holding with subtle
 * ambient motion.
 *
 * Prompts are hand-built, deterministic, and never routed through
 * H3-Promptor — a real 6-chunk test run (2026-08-21) showed the local LLM
 * behind Promptor does not reliably emit MiniMax's official
 * `<d>[Language] "text"</d>` lip-sync dialogue tag: it wrote plain narration
 * instead, and repeated the full dialogue line across all shots of one clip
 * rather than speaking it once, producing garbled, rushed audio. A hand-built
 * prompt with the tag placed correctly exactly once sounded fine — hence
 * hand-building every chunk the same way. (H3-Promptor remains fine for
 * non-dialogue VideoAgent prompts elsewhere.)
 *
 * A per-chunk voice-recording path (lip-syncing each clip to the user's own
 * recorded audio via Ref2VA's ref_audios) was tried and removed — measured
 * near-zero cross-correlation between the supplied recordings and the
 * generated audio, meaning MiniMax H3's ref_audios/<Audio N> input isn't
 * actually driving speech content in this ComfyUI integration. H3's default
 * voice via plain dialogue tags is the only path that's actually verified to
 * work — and a single fixed seed for the whole chain (below) keeps that
 * default voice/timbre consistent across chunks instead of re-rolling it.
 *
 * @param {string} endpoint
 * @param {{name: string, dataUrl: string}[]} referenceImages  All attached
 *   reference images, matched against each chunk's `imageName` by name.
 * @param {{imageName: string|null, dialogue: string}[]} chunks  In order (see parseScriptChunks).
 * @param {object} opts  { durationSeconds, width, height, upscaleTo1080p, timeoutMs, environmentPrompt }
 * @param {(i: number, total: number) => void} [onChunkStart]
 * @param {(i: number, text: string) => void} [onChunkExpanded]  Fires synchronously
 *   with each chunk's actual hand-built prompt, before generation starts.
 * @param {(i: number, result: object) => void} [onChunkDone]
 * @param {(msg: string) => void} [onProgress]  Live sampling progress, shared across all chunks.
 * @returns {Promise<object[]>} one video result (filename/subfolder/type) per chunk, in order.
 */
const SOUNDSCAPE_SUFFIX = `

overall_soundscape:
Soft office ambience — distant keyboard clatter, muted conversation, footsteps on carpet.

non_diegetic_music:
N/A`;

function resolveChunkImage(imageName, currentFrame, imageMap, referenceImages, chunkIndex) {
  if (imageName) {
    const found = imageMap.get(imageName.toLowerCase().trim());
    if (!found) {
      const available = referenceImages.map(r => r.name).join(', ') || '(none attached)';
      throw new Error(`Chunk ${chunkIndex + 1} references image "${imageName}" but no attached file matches that name. Attached: ${available}`);
    }
    return { image: found, isNamedImage: true, isFallbackEstablishing: false };
  }
  if (currentFrame) {
    return { image: currentFrame, isNamedImage: false, isFallbackEstablishing: false };
  }
  if (referenceImages.length === 1) {
    return { image: referenceImages[0], isNamedImage: false, isFallbackEstablishing: true };
  }
  const available = referenceImages.map(r => r.name).join(', ') || 'none';
  throw new Error(`Chunk ${chunkIndex + 1} doesn't specify an "Image:" line and there's no previous chunk to continue from. Attach exactly one reference image to use as a fallback, or add "Image: <filename>" to this chunk (attached: ${available}).`);
}

// Stage A ("establish"): a short silent Ref2VA pass whose only job is to
// commit the reference image to one concrete, natural-looking scene before
// Stage B pins the whole real clip to it. isFallbackEstablishing keeps the
// old single-photo "walk into the room" framing for the one case where the
// reference is a bare headshot with no scripted `Image:` lines at all;
// every named-image chunk just asks H3 to hold what it's given.
function buildEstablishPrompt(isFallbackEstablishing, environmentPrompt) {
  const clause = isFallbackEstablishing
    ? `a professional person (S1), matching <Picture 1>, walks toward the camera through ${environmentPrompt}, face and expression clearly visible throughout. The camera stays directly in front of them, Pull Out at slow speed to hold the framing as they approach.`
    : `matching <Picture 1> exactly — same subject or scene, same lighting, framing, and setting — the camera holds a static composition, subtle natural ambient movement only.`;
  return `integrated_multimodal_description:\n[Shot 1] At 00:00.000, ${clause}${SOUNDSCAPE_SUFFIX}`;
}

// Stage B ("hold"): the real clip, FL2V-pinned at both ends to Stage A's
// established frame — no more "walk in" framing needed here, that already
// happened in Stage A, so this is always just dialogue-to-camera or ambient.
// Dialogue chunks deliberately do NOT re-assert "matching exactly / never
// changes" — a documented H3 anti-pattern: once there's a strong image
// anchor, re-describing identity/background in the text prompt invites the
// model to reinterpret rather than hold it. These are also I2V (single
// first_frame anchor, no last_frame pin — see generateChunk) since forcing
// an identical frozen bookend at both ends while also demanding several
// seconds of natural speech is a self-contradiction that produced a visible
// "pops in front of the background, pops back" artifact in testing. B-roll
// chunks have no such conflict (no motion demand beyond ambient drift), so
// they keep the "matching exactly" language and the FL2V dual-pin, which is
// exactly the static-hold use case that combination suits.
function buildChunkPrompt(dialogue) {
  if (dialogue) {
    return `integrated_multimodal_description:\n[Shot 1] At 00:00.000, (S1) is present, facing the camera, and speaks: <d>[English] "${dialogue}"</d>${SOUNDSCAPE_SUFFIX}`;
  }
  const openingClause = `matching the exact composition, lighting, framing, and background of the starting image throughout — the background never changes to a different room or setting — the scene holds with subtle ambient movement — gentle camera drift or push-in, natural background activity.`;
  return `integrated_multimodal_description:\n[Shot 1] At 00:00.000, ${openingClause}${SOUNDSCAPE_SUFFIX}`;
}

// Validates every chunk's image resolution BEFORE any generation starts —
// without this, a bad "Image:" reference in (say) chunk 5 only surfaces
// after chunks 1-4 have already spent real GPU time rendering, since
// resolveChunkImage otherwise only runs lazily as each chunk is reached in
// the loop below. Mirrors resolveChunkImage's exact logic; only chunk 0 can
// ever hit the "no previous frame" case since every later chunk always has
// one available (any earlier chunk resolving, by any path, produces one).
function validateAllChunkImages(chunks, imageMap, referenceImages) {
  chunks.forEach((chunk, i) => {
    if (chunk.imageName) {
      if (!imageMap.has(chunk.imageName.toLowerCase().trim())) {
        const available = referenceImages.map(r => r.name).join(', ') || '(none attached)';
        throw new Error(`Chunk ${i + 1} references image "${chunk.imageName}" but no attached file matches that name. Attached: ${available}`);
      }
    } else if (i === 0 && referenceImages.length !== 1) {
      const available = referenceImages.map(r => r.name).join(', ') || 'none';
      throw new Error(`Chunk 1 doesn't specify an "Image:" line and there's no previous chunk to continue from. Attach exactly one reference image to use as a fallback, or add "Image: <filename>" to this chunk (attached: ${available}).`);
    }
  });
}

// H3's documented minimum trained length is k=7 (17*7+5=124 frames, ~5.17s
// at 24fps) — the establishing pass doesn't need to be any longer than that
// since only its last frame is ever used.
const ESTABLISH_DURATION_SECONDS = 5.2;

async function generateChunk(endpoint, i, chunk, imageMap, referenceImages, currentFrame, environmentPrompt, sceneImage, gen, onProgress, onChunkExpanded) {
  const { timeoutMs, durationSeconds, width, height, upscaleTo1080p, extractLastFrame, steps, seed } = gen;
  const { image, isFallbackEstablishing } = resolveChunkImage(chunk.imageName, currentFrame, imageMap, referenceImages, i);

  if (chunk.dialogue && !isFallbackEstablishing && currentFrame) {
    // Every dialogue chunk after the first chains from the previous chunk's
    // own extracted last frame via FL2V (both ends pinned to it) — a hard
    // pixel anchor, so this chunk's first frame is literally the previous
    // chunk's last frame. That guarantees zero visual jump at the cut,
    // unlike an independent Ref2VA call, which recomposes its own camera
    // angle/framing from scratch every time even given the same character
    // and scene references (confirmed: same person and location, but a
    // different shot composition each call — "the view always jumps").
    const prompt = buildChunkPrompt(chunk.dialogue);
    onChunkExpanded?.(i, prompt);
    return generateFL2V(
      endpoint, prompt, currentFrame, currentFrame, timeoutMs, durationSeconds, width, height,
      onProgress, false, undefined, undefined,
      upscaleTo1080p, extractLastFrame, steps, seed,
    );
  }

  if (chunk.dialogue && !isFallbackEstablishing) {
    // First dialogue chunk in the chain — no previous frame to continue
    // from yet. Establish character + scene via a short SILENT Ref2VA pass
    // first (both bound in one call via a mapping block, per H3's
    // documented multi-reference convention), then FL2V-pin the real
    // dialogue to ITS last frame — mirrors how every later chunk chains
    // from a real frame (see above). Generating the real dialogue directly
    // in the multi-reference Ref2VA call was tried first and confirmed
    // broken: H3 spends the first ~3s of the clip still showing mostly the
    // bare character reference's own plain backdrop, visibly cross-
    // dissolving into the office only partway through (fully resolved by
    // ~4.3s in testing) — using a dedicated establish pass and keeping only
    // its last frame skips past that dissolve entirely.
    // "facing the camera" alone wasn't a strong enough constraint — H3
    // sometimes composed a wide establishing shot with two or three
    // unrelated people scattered around the location instead of a clear
    // solo shot of the actual character, and since every later chunk now
    // chains from this exact frame, that ambiguity propagated through the
    // entire rest of the video instead of just this one chunk. Fixed via
    // "alone / no other people visible" — but a first attempt at that fix
    // also added "medium close-up shot," which turned out to be a real
    // regression, not seed luck: two separate runs with two different office
    // images both came back on the character's own plain backdrop with zero
    // trace of <Picture 2> once that phrase was added, after <Picture 2>
    // had fused reliably in every earlier prompt variant that didn't ask
    // for a tight close-up. A close-up crop gives the model no reason to
    // render background detail at all — dropped the close-up framing,
    // kept "alone / no other people" (a solo-person constraint, not a
    // framing constraint) so the room stays visible without reintroducing
    // extra people.
    const establishSeed = Math.floor(Math.random() * 2 ** 32);
    const establishPrompt = composeRef2VAPrompt(
      `integrated_multimodal_description:\n[Shot 1] At 00:00.000, <Picture 1> alone, no other people visible in frame, stands in <Picture 2>, facing the camera directly, expression neutral, camera holds a static wide composition showing the surrounding room.${SOUNDSCAPE_SUFFIX}`,
      [{ label: 'the presenter', kind: 'image' }, { label: 'the office setting', kind: 'image' }],
    );
    const establishResult = await generateRef2V(
      endpoint, establishPrompt, [image, sceneImage], [], timeoutMs, ESTABLISH_DURATION_SECONDS, width, height,
      onProgress, false, true, false, 'Chain establish (Ref2VA multi-reference)', undefined, steps, establishSeed,
    );
    if (!establishResult.lastFrame) throw new Error(`Chunk ${i + 1}: establishing Ref2VA pass did not return an extracted last frame`);

    const prompt = buildChunkPrompt(chunk.dialogue);
    onChunkExpanded?.(i, prompt);
    return generateFL2V(
      endpoint, prompt, establishResult.lastFrame, establishResult.lastFrame, timeoutMs, durationSeconds, width, height,
      onProgress, false, undefined, undefined,
      upscaleTo1080p, extractLastFrame, steps, seed,
    );
  }

  // Non-dialogue (B-roll) and the old single-photo fallback both still use
  // the anchor-image + FL2V-dual-pin path: B-roll has no motion demand
  // beyond ambient drift, so holding a static composition is exactly what
  // "matching exactly / never changes" language and pinning both ends to
  // the same frame suits. The fallback (no `Image:` lines at all, so the
  // only reference is a bare headshot with no environment) still needs
  // Ref2VA's willingness to recompose to place it in the environment first.
  let anchorImage = image;
  if (isFallbackEstablishing) {
    const establishSeed = Math.floor(Math.random() * 2 ** 32);
    const establishPrompt = buildEstablishPrompt(isFallbackEstablishing, environmentPrompt);
    const establishResult = await generateRef2V(
      endpoint, establishPrompt, [image], [], timeoutMs, ESTABLISH_DURATION_SECONDS, width, height,
      onProgress, false, true, false, 'Chain establish (Ref2VA)', undefined, steps, establishSeed,
    );
    if (!establishResult.lastFrame) throw new Error(`Chunk ${i + 1}: establishing Ref2VA pass did not return an extracted last frame`);
    anchorImage = establishResult.lastFrame;
  }

  const prompt = buildChunkPrompt(chunk.dialogue);
  onChunkExpanded?.(i, prompt);
  return generateFL2V(
    endpoint, prompt, anchorImage, anchorImage, timeoutMs, durationSeconds, width, height,
    onProgress, false, undefined, undefined,
    upscaleTo1080p, extractLastFrame, steps, seed,
  );
}

export async function generateChainedVideo(endpoint, referenceImages, chunks, opts = {}, onChunkStart, onChunkExpanded, onChunkDone, onProgress) {
  const {
    durationSeconds, // optional fixed override; omitted => each chunk's duration is estimated from its own dialogue length (see estimateDialogueDuration)
    width = 960,
    height = 544,
    upscaleTo1080p = false,
    timeoutMs = 5_400_000,
    steps = 20,
    environmentPrompt = 'a busy, modern open-plan office, cubicles and colleagues visible in the background, natural daylight through large windows',
  } = opts;

  const total = chunks.length;
  if (total === 0) throw new Error('No dialogue chunks found in script');

  const imageMap = new Map(referenceImages.map(r => [r.name.toLowerCase().trim(), r]));
  validateAllChunkImages(chunks, imageMap, referenceImages);

  // One shared scene reference for every dialogue chunk in the chain,
  // reused as <Picture 2> so every talking-head chunk is bound to the same
  // real location photo instead of each inventing its own generic office.
  // Prefer whichever attached image no chunk names directly (e.g. an office
  // photo attached alongside the character photo purely to serve as the
  // scene reference) — falls back to chunk 1's own image for scripts that
  // still use a B-roll opener as the de facto location shot.
  const namedImages = new Set(chunks.map(c => c.imageName?.toLowerCase().trim()).filter(Boolean));
  const unnamedImages = referenceImages.filter(r => !namedImages.has(r.name.toLowerCase().trim()));
  const sceneImage = unnamedImages[0] ?? resolveChunkImage(chunks[0].imageName, null, imageMap, referenceImages, 0).image;

  // One fixed seed for the entire chain — H3 is a joint audio-video
  // diffusion model, so re-rolling a random seed per chunk (the old
  // behavior) let the voice/timbre H3 picks drift chunk to chunk along with
  // the noise pattern, independent of any reference images.
  const seed = Math.floor(Math.random() * 2 ** 32);

  const results = [];
  let currentFrame = null; // {name, dataUrl} — set once a chunk without its own named image needs it

  for (let i = 0; i < total; i++) {
    onChunkStart?.(i, total);
    const chunk = chunks[i];
    const isLast = i === total - 1;
    const chunkDuration = durationSeconds ?? estimateDialogueDuration(chunk.dialogue);
    const gen = { timeoutMs, durationSeconds: chunkDuration, width, height, upscaleTo1080p, extractLastFrame: !isLast, steps, seed };

    const result = await generateChunk(endpoint, i, chunk, imageMap, referenceImages, currentFrame, environmentPrompt, sceneImage, gen, onProgress, onChunkExpanded);

    results.push(result);
    onChunkDone?.(i, result);

    if (!isLast) {
      if (!result.lastFrame) throw new Error(`Chunk ${i + 1} did not return an extracted last frame — cannot continue the chain`);
      currentFrame = result.lastFrame;
    }
  }

  return results;
}

/**
 * Generate a LTX-2.5 text-to-video.
 * @param {number} durationSeconds  Clip length, default 12s (24fps*seconds+1 frames, no grid constraint).
 * @param {number} width/height     Native generation resolution, default 1280x720; output is
 *   always resized to exactly 1920x1080 regardless of this value.
 */
export async function generateLTXVideo(endpoint, prompt, timeoutMs = 300_000, durationSeconds = 12, width = 1280, height = 720, onProgress, extractLastFrame = false) {
  const clientId = `alice-ltx-video-${Date.now()}`;
  const workflow = buildLTXWorkflow(prompt, { durationSeconds, width, height, extractLastFrame });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] ltx t2v queued: ${promptId}`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress);
}

/**
 * Generate a LTX-2.5 image-to-video (animates forward from an exact first frame).
 * @param {object} imageData - { name: string, dataUrl: string } base64 image
 * @param {number} durationSeconds/width/height - See generateLTXVideo.
 */
export async function generateLTXI2V(endpoint, prompt, imageData, timeoutMs = 300_000, durationSeconds = 12, width = 1280, height = 720, onProgress, extractLastFrame = false) {
  const clientId = `alice-ltx-i2v-${Date.now()}`;
  const firstFrameName = await uploadMediaToComfy(endpoint, imageData.dataUrl, imageData.name);
  const workflow = buildLTXWorkflow(prompt, { firstFrameName, durationSeconds, width, height, extractLastFrame });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] ltx i2v queued: ${promptId} (first frame: ${firstFrameName})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress);
}

/**
 * Generate a LTX-2.5 first/last-frame video (single-pass — see
 * buildLTXFirstLastFrameWorkflow's header for why this differs structurally
 * from generateLTXI2V's 2-pass pipeline).
 * @param {object} firstImageData/lastImageData - { name: string, dataUrl: string } base64 images
 * @param {number} durationSeconds/width/height - See generateLTXVideo.
 */
export async function generateLTXFL2V(endpoint, prompt, firstImageData, lastImageData, timeoutMs = 300_000, durationSeconds = 12, width = 1280, height = 720, onProgress, extractLastFrame = false) {
  const clientId = `alice-ltx-fl2v-${Date.now()}`;
  const firstFrameName = await uploadMediaToComfy(endpoint, firstImageData.dataUrl, firstImageData.name);
  const lastFrameName = await uploadMediaToComfy(endpoint, lastImageData.dataUrl, lastImageData.name);
  const workflow = buildLTXFirstLastFrameWorkflow(prompt, { firstFrameName, lastFrameName, durationSeconds, width, height, extractLastFrame });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[videoClient] ltx fl2v queued: ${promptId} (first: ${firstFrameName}, last: ${lastFrameName})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress);
}
