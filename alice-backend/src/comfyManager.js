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
 * transient memory — far more headroom than the persistent vLLM chat backend
 * leaves free on this unified-memory box. vLLM's sleep-mode was investigated
 * and ruled out (unreliable on unified memory, dev-only HTTP surface, open
 * DGX-Spark crash bug) — so instead we fully stop vllm-laguna before a
 * ComfyUI job and restart it after, swapping litellm-gateway's config so
 * chat agents fail over to a small Ollama model for the duration rather than
 * hard-erroring. Generation jobs are occasional, not constant, chat traffic.
 *
 * History: this used to separately manage two spark-vllm-docker `--rm`
 * containers (alice-vllm-mail on :8003, alice-vllm-coder on :8002) — those
 * were retired in favor of routing every chat role (general/coder/mail, plus
 * AliceBuilder's own CCR/Continue/OpenHands and TheiaCast's theia-assistant)
 * through the single vllm-laguna container that AliceBuilder's
 * docker-compose.yml manages. A prior version of this file paused those two
 * containers on ComfyUI jobs but had no idea vllm-laguna existed — it kept
 * running the whole time, and the combined memory pressure (ComfyUI + a
 * fully-resident vllm-laguna + a stuck backend relaunch) hard-crashed the box
 * on 2026-08-01, needing a physical reboot. Do not reintroduce a second,
 * uncoordinated LLM-pause mechanism outside this file.
 *
 * vllm-laguna is docker-compose managed (`restart: unless-stopped`, NOT
 * `--rm`) — `docker stop` does not remove it, so resume is a cheap
 * `docker start`, not a full relaunch.
 */

import { spawn, execFile } from 'node:child_process';
import { config } from './config.js';

const LITELLM_DIR = '/home/jimmy/litellm';
const VLLM_LAGUNA = { name: 'alice-vllm-laguna', port: 8765 };
const LLM_RESTART_HEALTH_TIMEOUT = 300_000; // cap while waking vllm-laguna back up (cold model load, not just a process start)

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

function dockerStop(name) {
  return runCmd('docker', ['stop', name]).then(({ err, stderr }) => {
    if (err) console.warn(`[comfyManager] docker stop ${name} failed (may already be stopped): ${stderr || err.message}`);
  });
}

function dockerStart(name) {
  return runCmd('docker', ['start', name]).then(({ err, stderr }) => {
    if (err) console.warn(`[comfyManager] docker start ${name} failed: ${stderr || err.message}`);
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
      setTimeout(check, 5_000);
    };
    check();
  });
}

/**
 * Point litellm-gateway's config at the given mode ('coding' -> vllm-laguna,
 * 'comfy' -> small Ollama fallback) and restart it to pick up the change.
 * Mirrors AliceBuilder's scripts/llm-mode-switch.sh, which is kept around as
 * a manual fallback tool — both share the same flock lock file (.mode.lock)
 * so a manual invocation can never interleave with this one, and both write
 * .mode so `cat /home/jimmy/litellm/.mode` reflects reality regardless of
 * which one made the last change.
 */
async function swapLitellmConfig(mode) {
  const cmd = `flock ${LITELLM_DIR}/.mode.lock -c "cp ${LITELLM_DIR}/config.${mode}.yaml ${LITELLM_DIR}/config.yaml && docker restart litellm-gateway && echo ${mode} > ${LITELLM_DIR}/.mode"`;
  const { err, stderr } = await runCmd('bash', ['-c', cmd]);
  if (err) console.error(`[comfyManager] failed to swap litellm-gateway to '${mode}' mode: ${stderr || err.message}`);
}

/**
 * Stop vllm-laguna and fail chat traffic over to a small Ollama model, to
 * free memory for a ComfyUI job. Tolerates failures — never throws.
 *
 * Also force-unloads any Ollama model currently resident (`ollama stop`,
 * harmless/no-op if nothing's loaded) — the comfy-mode chat fallback
 * (qwen3:8b) and the vision route (alice-vision, ~15GB with an 8192-token
 * context) both live on Ollama, and its default 5-minute keep-alive means a
 * model used just before a video/image job can still be fully resident when
 * ComfyUI launches. On this unified-memory box that's real GPU contention
 * with ComfyUI's own dynamic-VRAM weight streaming — observed firsthand as
 * a ~6x sampling slowdown (2026-08-09) after a VideoScriptAgent call loaded
 * alice-vision immediately before a VideoAgent job. `ollama stop` without a
 * model name isn't valid, so this queries `ollama ps` first.
 */
export async function pauseLLMBackends() {
  console.log('[comfyManager] pausing vllm-laguna to free memory for ComfyUI...');
  await dockerStop(VLLM_LAGUNA.name);
  await unloadOllamaModels();
  await swapLitellmConfig('comfy');
}

async function unloadOllamaModels() {
  const { err, stdout } = await runCmd('ollama', ['ps']);
  if (err) return; // Ollama not installed/reachable — nothing to unload
  const loaded = stdout
    .split('\n')
    .slice(1) // header row
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  for (const model of loaded) {
    console.log(`[comfyManager] unloading Ollama model ${model} to free GPU memory for ComfyUI...`);
    await runCmd('ollama', ['stop', model]);
  }
}

/**
 * Restart vllm-laguna and restore litellm-gateway's routes to it once it's
 * actually answering requests — not just once the container process has
 * launched (loading the model takes 30-90s+; restarting the gateway before
 * that finishes routes traffic into a backend that isn't serving yet).
 * Intended to be fire-and-forget from the caller — does not throw.
 */
export async function resumeLLMBackends() {
  console.log('[comfyManager] resuming vllm-laguna...');
  await dockerStart(VLLM_LAGUNA.name);
  await waitForBackendHealthy(VLLM_LAGUNA.port);
  await swapLitellmConfig('coding');
  console.log('[comfyManager] vllm-laguna resumed, litellm-gateway routes restored');
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
  // --enable-manager (REMOVED 2026-08-09): it turns on ComfyUI-Manager's
  // search/install UI for custom node packs, but this is a headless,
  // API-driven launch — nothing ever browses that UI, and every node this
  // pipeline uses (MiniMaxH3*, UpscaleModelLoader, etc.) is core ComfyUI,
  // not a Manager-installed package. It also crashed a real job: Manager's
  // stderr-wrapping logger (comfyui_manager/prestartup_script.py) sits
  // between tqdm's per-step progress writes and the console, and its pipe
  // broke mid-sampling, raising BrokenPipeError and killing the whole node
  // (SamplerCustomAdvanced) — not a memory or model issue, confirmed via the
  // full traceback in ComfyUI's /history for that prompt_id. No upside here,
  // real downside — leave this flag off.
  const args = ['main.py', '--listen', listenAddr, '--reserve-vram', '8', '--disable-pinned-memory'];
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
      // ~/.triton/cache is root-owned from some earlier process (not ours to
      // fix — no passwordless sudo here) — point Triton at a directory this
      // user actually owns instead of failing to create new cache-key
      // subdirs under root's tree. Hit by LTX-2.5's Gemma4 int8_convrot
      // dequantization kernel on first use (2026-09-09).
      TRITON_CACHE_DIR: `${venvDir}/.triton-cache`,
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
