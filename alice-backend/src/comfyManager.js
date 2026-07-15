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
 * transient memory — far more headroom than the persistent vLLM chat
 * backends leave free on this unified-memory box. vLLM's sleep-mode was
 * investigated and ruled out (unreliable on unified memory, dev-only HTTP
 * surface, open DGX-Spark crash bug) — so instead we fully stop the vLLM
 * containers before a ComfyUI job and restart them after. Chat agents will
 * return LLMUnavailableError for the duration; accepted tradeoff since
 * generation jobs are occasional, not constant, chat traffic.
 *
 * IMPORTANT: spark-vllm-docker's launch-cluster.sh always runs its containers
 * with `docker run --rm` (hardcoded, no override flag) — so `docker stop`
 * DELETES them, not just stops them. `docker start` on a since-removed
 * container is a silent no-op failure. So "resume" here means fully
 * re-running each backend's launch command from scratch, not `docker start`.
 * (Confirmed the hard way: a stop cycle without this fix left both LLM
 * backends gone until manually relaunched.)
 */

import { spawn, execFile } from 'node:child_process';
import { config } from './config.js';

// Each LLM backend's full (re)launch command — same one used to originally
// stand it up. `docker stop` removes these containers (see note above), so
// resume must re-run the launch command, not `docker start`.
const LLM_BACKENDS = {
  'alice-vllm-mail': {
    port: 8003,
    launchCmd: 'cd /home/jimmy/spark-vllm-docker && python3 run-recipe.py nemotron-3-nano-nvfp4 --solo --gpu-memory-utilization 0.24 --max-model-len 32768 --name alice-vllm-mail -p 127.0.0.1:8003:8000 -d -- --served-model-name nemotron-3-nano --max-num-seqs 4',
  },
  'alice-vllm-coder': {
    port: 8002,
    // Also serves the "general" role — see litellm config.yaml (alice-general
    // and theia-assistant both point at this same backend).
    launchCmd: 'cd /home/jimmy/spark-vllm-docker && python3 run-recipe.py qwen3.6-35b-a3b-nvfp4-no-mtp --solo --tensor-parallel 1 --gpu-memory-utilization 0.28 --max-model-len 32768 --name alice-vllm-coder -p 127.0.0.1:8002:8000 -d -- --served-model-name qwen3.6-coder',
  },
};
const LLM_RESTART_HEALTH_TIMEOUT = 300_000; // per-container cap while waking backends back up (cold model load, not just a process start)

function dockerStop(name) {
  return new Promise((resolve) => {
    execFile('docker', ['stop', name], (err) => {
      if (err) console.warn(`[comfyManager] docker stop ${name} failed (may already be stopped/removed): ${err.message}`);
      resolve();
    });
  });
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

/**
 * `--rm` containers don't disappear the instant `docker stop` returns — the
 * actual removal happens asynchronously shortly after. Observed in practice:
 * an immediate `docker rm -f` + relaunch attempt right after `pauseLLMBackends()`
 * can race that cleanup and hit "Conflict: name already in use" even though
 * `docker rm -f` was called first. Retry the full remove+launch a few times
 * rather than assuming one attempt is enough.
 */
async function relaunch(name, launchCmd, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    await runCmd('docker', ['rm', '-f', name]); // tolerate "no such container"
    const { err, stderr } = await runCmd('bash', ['-c', launchCmd]);
    if (!err) return;
    const isNameConflict = /already in use|Conflict/i.test(stderr || '');
    if (!isNameConflict || i === attempts - 1) {
      console.error(`[comfyManager] failed to relaunch ${name}: ${err.message}\n${stderr}`);
      return;
    }
    console.warn(`[comfyManager] ${name} relaunch hit a name conflict (attempt ${i + 1}/${attempts}), retrying...`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
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
      setTimeout(check, 5_000);
    };
    check();
  });
}

/**
 * Stop all LLM backend containers to free memory for a ComfyUI job.
 * Tolerates individual failures (e.g. already stopped) — never throws.
 * Note: this REMOVES the containers (see module header) — resumeLLMBackends()
 * knows to relaunch them from scratch, not `docker start`.
 */
export async function pauseLLMBackends() {
  console.log('[comfyManager] pausing LLM backends to free memory for ComfyUI...');
  await Promise.all(Object.keys(LLM_BACKENDS).map((name) => dockerStop(name)));
}

/**
 * Relaunch all LLM backend containers from scratch, one at a time (mirroring
 * the same one-at-a-time caution used for initial cold-boot bring-up, since
 * combined startup memory overshoot is more of a risk than steady-state
 * usage). Intended to be fire-and-forget from the caller — does not throw.
 */
export async function resumeLLMBackends() {
  console.log('[comfyManager] relaunching LLM backends...');
  for (const [name, { port, launchCmd }] of Object.entries(LLM_BACKENDS)) {
    await relaunch(name, launchCmd);
    await waitForBackendHealthy(port);
  }
  console.log('[comfyManager] LLM backends relaunched');
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

  // DGX Spark (GB10 unified-memory) specific flags, from independent reports
  // of running ComfyUI on this exact hardware:
  //  --reserve-vram 8        headroom for activations on the unified pool
  //  --disable-pinned-memory pinning is pointless when CPU/GPU share memory
  // Deliberately NOT setting any global --bf16-*/--fp16-*/--force-fp16 or
  // --disable-mmap flag — both are reported to work on other models but to
  // break LTX-2.x specifically (all-black video, no error), which is exactly
  // what we run for I2V.
  // --enable-manager turns on ComfyUI-Manager, which is built into core now
  // rather than a separate custom_nodes install — without this flag there's
  // no search/install UI for custom node packs at all.
  const args = ['main.py', '--listen', listenAddr, '--reserve-vram', '8', '--disable-pinned-memory', '--enable-manager'];
  console.log(`[comfyManager] launching ComfyUI (${pythonBin} ${args.join(' ')})...`);

  // Use the venv python directly — avoids bash wrapper issues
  const proc = spawn(pythonBin, args, {
    cwd: comfyDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VIRTUAL_ENV: venvDir,
      PATH: `${venvDir}/bin:${process.env.PATH}`,
      // Stops PyTorch's caching allocator hoarding pages from the shared
      // unified-memory pool instead of returning them promptly.
      PYTORCH_NO_CUDA_MEMORY_CACHING: '1',
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
