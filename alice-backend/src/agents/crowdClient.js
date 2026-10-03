/**
 * Batch crowd-asset generation: N distinct full-body photos (varied
 * outfit/pose/gender-presentation prompts, same plain-background framing
 * Hunyuan3D needs) -> textured 3D mesh each, zipped into one archive.
 *
 * Only the prompt-variety pool and the zip/manifest packaging are specific
 * to "crowd" — the actual image generation (referenceImage.js) and 3D step
 * (hunyuan3dWorker.js) are the same shared building blocks /agent/mesh uses
 * for a single arbitrary asset. See hunyuan3dWorker.js for why the 3D step
 * runs as a fresh subprocess per member rather than a resident process.
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { generateReferenceImage } from './referenceImage.js';
import { run3DWorker } from './hunyuan3dWorker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CROWD_DIR = join(__dirname, '..', '..', 'data', 'crowd');

export const MAX_CROWD_COUNT = 20;

// ── Prompt variety ──────────────────────────────────────────────────────
// Only the subject varies — framing stays fixed (full body, plain white
// background, centered, even lighting) since that's what Hunyuan3D needs
// for a clean background removal + reconstruction.
const WHO = [
  'a young woman', 'a young man', 'a woman in her 40s', 'a man in his 30s',
  'a teenage girl', 'a teenage boy', 'an elderly woman', 'an elderly man',
];
const OUTFITS = [
  'wearing a colorful tie-dye t-shirt and denim shorts, round sunglasses',
  'wearing a flower crown, crop top, and denim shorts, ankle boots',
  'wearing a bohemian fringe vest over a tank top, ripped jeans, sandals',
  'wearing a graphic band t-shirt, cargo shorts, canvas sneakers',
  'wearing a sequined festival top, high-waisted shorts, glitter face paint',
  'wearing a flannel shirt tied at the waist, denim shorts, combat boots',
  'wearing a crochet top, denim shorts, layered beaded necklaces',
  'wearing a neon rave outfit with fishnet sleeves, platform boots',
  'wearing a denim jacket covered in pins, band t-shirt, black jeans',
  'wearing a linen shirt, straw hat, cargo pants, hiking boots',
];
const POSES = [
  'standing pose facing camera, arms relaxed at sides',
  'standing pose, one hand raised in a peace sign',
  'standing pose, arms crossed, confident stance',
  'standing pose, dancing with arms raised above head',
  'standing pose, hands in pockets, relaxed stance',
  'standing pose, one hand shielding eyes as if looking at a stage',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPrompt() {
  return `full body photo of ${pick(WHO)} at a music festival, ${pick(POSES)}, ${pick(OUTFITS)}, `
    + 'plain seamless white studio background, soft even studio lighting, photorealistic, '
    + 'sharp focus, entire body visible head to toe, centered in frame';
}

// ── Batch entry point ────────────────────────────────────────────────────

/**
 * @param {number} count
 * @param {object} opts { onProgress?: ({completed, total, current}) => void }
 * @returns {Promise<{buffer: Buffer, members: Array}>}
 */
export async function generateCrowd(count, opts = {}) {
  const batchId = randomUUID();
  const outDir = join(CROWD_DIR, batchId);
  mkdirSync(outDir, { recursive: true });

  const members = [];
  for (let i = 0; i < count; i++) {
    const name = `member_${String(i + 1).padStart(2, '0')}`;
    opts.onProgress?.({ completed: i, total: count, current: name });
    const prompt = buildPrompt();
    try {
      const imgBuffer = await generateReferenceImage(prompt, { imageModel: 'auto', width: 896, height: 1152 });
      const imgPath = join(outDir, `${name}_source.png`);
      writeFileSync(imgPath, imgBuffer);
      await run3DWorker(imgPath, outDir, name);
      members.push({ name, prompt, ok: true });
    } catch (err) {
      members.push({ name, prompt, ok: false, error: err.message });
    }
  }
  opts.onProgress?.({ completed: count, total: count, current: null });

  // Bundled inside the zip (not a response header) — per-member prompts add
  // up past typical HTTP header size limits once count gets large.
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ members }, null, 2));

  const zipPath = join(CROWD_DIR, `${batchId}.zip`);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(outDir, false);
    archive.finalize();
  });

  const buffer = readFileSync(zipPath);
  try { unlinkSync(zipPath); } catch { /* not fatal — file just lingers */ }
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* not fatal */ }

  return { buffer, members };
}
