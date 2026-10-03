/**
 * Generic single-asset image -> textured 3D mesh (any subject, not just
 * crowd characters — a prop, a vehicle, an animal, whatever). Either
 * generates a reference photo from a prompt (Flux.2/ComfyUI, same as
 * /agent/image) or uses a caller-supplied image directly.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateReferenceImage, decodeSuppliedImage } from './referenceImage.js';
import { run3DWorker } from './hunyuan3dWorker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MESH_DIR = join(__dirname, '..', '..', 'data', 'mesh3d');

/**
 * @param {object} opts
 *   prompt?: string — generate a reference photo (mutually exclusive with image)
 *   image?: { name, dataUrl } — use a supplied image directly instead of generating one
 *   imageModel?, imageAspect?, upscale4k?, width?, height? — only used with prompt
 * @returns {Promise<{glbBuffer: Buffer, previewBuffer: Buffer|null, sourceBuffer: Buffer}>}
 */
export async function generateMesh3D(opts = {}) {
  const id = randomUUID();
  const outDir = join(MESH_DIR, id);
  mkdirSync(outDir, { recursive: true });

  try {
    const sourceBuffer = opts.image
      ? decodeSuppliedImage(opts.image)
      : await generateReferenceImage(opts.prompt, opts);

    const imgPath = join(outDir, 'source.png');
    writeFileSync(imgPath, sourceBuffer);

    await run3DWorker(imgPath, outDir, 'asset');

    const glbBuffer = readFileSync(join(outDir, 'asset.glb'));
    let previewBuffer = null;
    try { previewBuffer = readFileSync(join(outDir, 'asset_preview.png')); } catch { /* render step is best-effort */ }

    return { glbBuffer, previewBuffer, sourceBuffer };
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* not fatal — dir just lingers */ }
  }
}
