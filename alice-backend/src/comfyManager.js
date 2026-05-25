/**
 * ComfyUI lifecycle manager — launches on demand, shuts down after idle.
 *
 * Instead of running ComfyUI 24/7, this module:
 *  1. Checks if ComfyUI is reachable before each job
 *  2. Launches it if not (using the configured venv + command)
 *  3. Frees VRAM after each job completes
 *  4. Shuts down ComfyUI after an idle timeout
 */

import { spawn } from 'node:child_process';
import { config } from './config.js';

// How long to wait after last job before killing ComfyUI (ms)
const IDLE_TIMEOUT = parseInt(process.env.COMFY_IDLE_TIMEOUT ?? '120000', 10); // 2 min default
const STARTUP_TIMEOUT = 60_000; // max time to wait for ComfyUI to become ready
const HEALTH_CHECK_INTERVAL = 2_000;

let comfyProcess = null;
let idleTimer = null;
let isStarting = false;
let startPromise = null;

/**
 * Check if ComfyUI is reachable.
 */
async function isRunning() {
  try {
    const res = await fetch(`${config.models.comfyui.endpoint}/system_stats`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch ComfyUI process.
 */
function launchProcess() {
  const comfyDir = process.env.COMFYUI_DIR ?? '/home/jimmy/ComfyUI';
  const venvDir = process.env.COMFYUI_VENV_DIR ?? '/home/jimmy/comfyui-env';
  const listenAddr = process.env.COMFYUI_LISTEN ?? '0.0.0.0';
  const pythonBin = `${venvDir}/bin/python`;

  console.log(`[comfyManager] launching ComfyUI (${pythonBin} main.py --listen ${listenAddr})...`);

  // Use the venv python directly — avoids bash wrapper issues
  const proc = spawn(pythonBin, ['main.py', '--listen', listenAddr], {
    cwd: comfyDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VIRTUAL_ENV: venvDir,
      PATH: `${venvDir}/bin:${process.env.PATH}`,
    },
  });

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[comfyUI] ${line}`);
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[comfyUI:err] ${line}`);
  });

  proc.on('exit', (code) => {
    console.log(`[comfyManager] ComfyUI exited (code ${code})`);
    comfyProcess = null;
    isStarting = false;
    startPromise = null;
  });

  proc.on('error', (err) => {
    console.error('[comfyManager] failed to launch ComfyUI:', err.message);
    comfyProcess = null;
    isStarting = false;
    startPromise = null;
  });

  return proc;
}

/**
 * Wait for ComfyUI to become reachable.
 */
function waitForReady() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STARTUP_TIMEOUT;
    const check = async () => {
      if (Date.now() > deadline) {
        reject(new Error('ComfyUI startup timed out'));
        return;
      }
      if (await isRunning()) {
        console.log('[comfyManager] ComfyUI is ready');
        resolve();
      } else {
        setTimeout(check, HEALTH_CHECK_INTERVAL);
      }
    };
    check();
  });
}

/**
 * Ensure ComfyUI is running. Launches it if needed.
 * Safe to call from multiple concurrent requests — coalesces into one launch.
 * Pauses the idle timer — call freeComfyMemory() after the job to restart it.
 */
export async function ensureComfyRunning() {
  // Pause idle timer while a job is about to run
  clearTimeout(idleTimer);
  idleTimer = null;

  // Already running?
  if (await isRunning()) {
    return;
  }

  // Already starting? Wait for the existing launch.
  if (isStarting && startPromise) {
    await startPromise;
    return;
  }

  // Launch
  isStarting = true;
  startPromise = (async () => {
    comfyProcess = launchProcess();
    await waitForReady();
    isStarting = false;
    // Don't start idle timer here — wait until freeComfyMemory() is called after the job
  })();

  await startPromise;
}

/**
 * Release ComfyUI after a job completes.
 * Shuts down the process immediately to free all VRAM — no idle timer guessing.
 * ComfyUI will be relaunched on demand for the next job.
 */
export async function freeComfyMemory() {
  shutdownComfy();
  console.log('[comfyManager] ComfyUI shut down after job');
}

/**
 * Shut down ComfyUI.
 */
export function shutdownComfy() {
  clearTimeout(idleTimer);
  idleTimer = null;

  if (comfyProcess) {
    console.log('[comfyManager] shutting down ComfyUI (idle timeout)');
    comfyProcess.kill('SIGTERM');
    // Give it a few seconds, then force kill
    setTimeout(() => {
      if (comfyProcess) {
        comfyProcess.kill('SIGKILL');
        comfyProcess = null;
      }
    }, 5_000);
  }
}

/**
 * Reset the idle shutdown timer.
 */
function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (IDLE_TIMEOUT > 0 && comfyProcess) {
    idleTimer = setTimeout(shutdownComfy, IDLE_TIMEOUT);
  }
}

// Clean up on process exit
process.on('exit', () => {
  if (comfyProcess) comfyProcess.kill('SIGTERM');
});
