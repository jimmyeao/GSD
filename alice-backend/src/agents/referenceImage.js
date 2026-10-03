/**
 * Shared "get a reference photo to feed into Hunyuan3D" step — either
 * generate one via Flux.2/ComfyUI (same in-process calls /agent/image
 * uses) or decode a caller-supplied image directly. Used by both
 * /agent/mesh (one asset, caller's own prompt/image) and /agent/crowd
 * (many, from its own varied prompt pool).
 */

import { config } from '../config.js';
import { generateImage } from './comfyClient.js';
import { ensureComfyRunning, freeComfyMemory } from '../comfyManager.js';

/**
 * @param {string} prompt
 * @param {object} opts { imageModel, imageAspect, upscale4k, width, height }
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function generateReferenceImage(prompt, opts = {}) {
  const {
    imageModel = 'auto',
    imageAspect = 'square',
    upscale4k = false,
    width,
    height,
  } = opts;
  await ensureComfyRunning();
  const timeoutMs = imageModel === 'flux2' ? 600_000 : config.models.comfyui.timeout;
  const customSize = (width && height) ? { width, height } : null;
  const imgData = await generateImage(
    config.models.comfyui.endpoint, prompt, '', timeoutMs,
    imageModel, imageAspect, upscale4k, customSize,
  );
  const viewUrl = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(imgData.filename)}`
    + `&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
  const imgRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) throw new Error(`Failed to fetch generated image from ComfyUI (${imgRes.status})`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  freeComfyMemory();
  return buffer;
}

/** Decodes a {name, dataUrl} image (same shape used elsewhere in this API,
 * e.g. video's firstFrame) into raw bytes — no ComfyUI/GPU involved. */
export function decodeSuppliedImage({ dataUrl }) {
  const match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('image.dataUrl must be a base64 data URL (data:image/...;base64,...)');
  return Buffer.from(match[1], 'base64');
}
