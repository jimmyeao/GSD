/**
 * ComfyUI lifecycle manager — launches on demand, shuts down after idle.
 *
 * Instead of running ComfyUI 24/7, this module:
 *  1. Checks if ComfyUI is reachable before each job
 *  2. Launches it if not (using the configured venv + command)
 *  3. Frees VRAM after each job completes
 *  4. Shuts down ComfyUI after an idle timeout
 *
 * ComfyUI's real checkpoints (LTX-2 video, Flux2 image) need up to ~53GB of
 * transient memory — far more headroom than the 3 persistent vLLM chat
 * backends leave free on this unified-memory box. vLLM's sleep-mode was
 * investigated and ruled out (unreliable on unified memory, dev-only HTTP
 * surface, open DGX-Spark crash bug) — so instead we fully stop the 3 vLLM
 * containers before a ComfyUI job and restart them after. Chat agents will
 * return LLMUnavailableError for the duration; accepted tradeoff since
 * generation jobs are occasional, not constant, chat traffic.
 */

import { spawn, execFile } from 'node:child_process';
import { config } from './config.js';

// name -> host port, used both for docker stop/start and post-restart health polling.
const LLM_BACKENDS = {
  'alice-vllm-general': 8001,
  'alice-vllm-coder': 8002,
  'alice-vllm-mail': 8003,
};
const LLM_RESTART_HEALTH_TIMEOUT = 180_000; // per-container cap while waking backends back up

function dockerCmd(action, name) {
  return new Promise((resolve) => {
    execFile('docker', [action, name], (err) => {
      if (err) console.warn(`[comfyManager] docker ${action} ${name} failed: ${err.message}`);
      resolve();
    });
  });
}

async function backendHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function waitForBackendHealthy(port) {
  return new Promise((resolve) => {
    const deadline = Date.now() + LLM_RESTART_HEALTH_TIMEOUT;
    const check = async () => {
      if (await backendHealthy(port)) { resolve(); return; }
      if (Date.now() > deadline) {
        console.warn(`[comfyManager] backend on port ${port} did not become healthy within timeout`);
        resolve(); // don't block the rest of the restart sequence on one stuck backend
        return;
      }
      setTimeout(check, 3_000);
    };
    check();
  });
}

/**
 * Stop all 3 LLM backend containers to free memory for a ComfyUI job.
 * Tolerates individual failures (e.g. already stopped) — never throws.
 */
async function pauseLLMBackends() {
  console.log('[comfyManager] pausing LLM backends to free memory for ComfyUI...');
  await Promise.all(Object.keys(LLM_BACKENDS).map((name) => dockerCmd('stop', name)));
}

/**
 * Restart the 3 LLM backend containers, one at a time (mirroring the same
 * one-at-a-time caution used for initial cold-boot bring-up, since combined
 * startup memory overshoot is more of a risk than steady-state usage).
 * Intended to be fire-and-forget from the caller — does not throw.
 */
async function resumeLLMBackends() {
  console.log('[comfyManager] restarting LLM backends...');
  for (const [name, port] of Object.entries(LLM_BACKENDS)) {
    await dockerCmd('start', name);
    await waitForBackendHealthy(port);
  }
  console.log('[comfyManager] LLM backends restarted');
}

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

  // Free memory for ComfyUI's much larger checkpoints before launching —
  // see the module header comment for why this stops the LLM backends
  // rather than using vLLM sleep-mode.
  await pauseLLMBackends();

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
  // Fire-and-forget: the image/video result shouldn't wait on the LLM
  // backends coming back up. resumeLLMBackends() never throws.
  resumeLLMBackends();
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
