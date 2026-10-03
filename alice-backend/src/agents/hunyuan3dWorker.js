/**
 * Shared Hunyuan3D-2.1 subprocess runner — the single-image -> textured
 * mesh step, used by both /agent/mesh (one asset) and /agent/crowd (many).
 * See generate_3d_asset.py's own header for the full "why a fresh
 * subprocess per call, why an isolated conda env" rationale.
 */

import { execFile } from 'node:child_process';

export const CONDA_BIN = process.env.HUNYUAN3D_CONDA_PATH ?? '/home/jimmy/miniconda3/bin/conda';
export const CONDA_ENV = process.env.HUNYUAN3D_CONDA_ENV ?? 'hunyuan3d';
export const HUNYUAN3D_DIR = process.env.HUNYUAN3D_DIR
  ?? '/home/jimmy/ComfyUI/custom_nodes/comfyui-ai-gamedev/external/Hunyuan3D-2.1';
const WORKER_SCRIPT = `${HUNYUAN3D_DIR}/generate_3d_asset.py`;
// Generous per-call ceiling — observed ~2-4 min (shape + texture paint,
// including cold model load from local cache each time), but a cold HF
// cache miss or a slow GPU moment shouldn't false-positive.
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Runs the 3D worker on an already-saved image file. Writes
 * <outDir>/<name>.glb (+ intermediates + _preview.png) on success.
 */
export function run3DWorker(imagePath, outDir, name) {
  return new Promise((resolve, reject) => {
    execFile(
      CONDA_BIN,
      ['run', '-n', CONDA_ENV, 'python', WORKER_SCRIPT, imagePath, outDir, name],
      { cwd: HUNYUAN3D_DIR, timeout: WORKER_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || stdout || err.message).slice(-2000);
          return reject(new Error(`3D worker failed for ${name}: ${tail}`));
        }
        resolve();
      },
    );
  });
}
