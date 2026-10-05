/**
 * Thin wrapper around the HyperFrames CLI (heygen-com/hyperframes) plus
 * ffprobe, for the explainer pipeline.
 *
 * HyperFrames needs Node 22+ while Alice runs on Node 20, so the CLI is a
 * separately pinned install (HYPERFRAMES_HOME, default
 * ~/.local/share/alice-hyperframes — `npm i hyperframes@<ver> gsap` under
 * Node 22) run with an explicit Node 22 binary, never `npx -y …@latest`.
 *
 * Box-specific environment (see memory: project-hyperframes-presenter-pipeline):
 *  - HYPERFRAMES_BROWSER_PATH → snap Chromium. The puppeteer cache's
 *    linux_arm-* builds on this box are actually x86-64 and can't run.
 *  - static aarch64 ffmpeg/ffprobe live in ~/.local/bin (not on the systemd
 *    unit's PATH by default).
 */

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
export const HYPERFRAMES_HOME = process.env.HYPERFRAMES_HOME ?? join(HOME, '.local/share/alice-hyperframes');
const NODE22 = process.env.HYPERFRAMES_NODE ?? join(HOME, '.local/share/fnm/node-versions/v22.23.3/installation/bin/node');
const CLI = join(HYPERFRAMES_HOME, 'node_modules/hyperframes/bin/hyperframes.mjs');
const LOCAL_BIN = join(HOME, '.local/bin');
export const FFPROBE = process.env.FFPROBE_BIN ?? join(LOCAL_BIN, 'ffprobe');
export const GSAP_JS = join(HYPERFRAMES_HOME, 'node_modules/gsap/dist/gsap.min.js');

function cliEnv() {
  return {
    ...process.env,
    PATH: `${LOCAL_BIN}:${process.env.PATH}`,
    HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH ?? '/snap/bin/chromium',
    HYPERFRAMES_SKIP_SKILLS: '1',
    DO_NOT_TRACK: '1',
    NO_COLOR: '1',
  };
}

function run(bin, args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: cliEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), killed: !!err?.killed });
    });
  });
}

function hf(args, opts) {
  return run(NODE22, [CLI, ...args], opts);
}

/** Fail fast with an actionable message if the pinned runtime is missing. */
export function assertRuntime() {
  for (const [label, p] of [['Node 22', NODE22], ['hyperframes CLI', CLI], ['gsap', GSAP_JS], ['ffprobe', FFPROBE]]) {
    if (!existsSync(p)) throw new Error(`HyperFrames runtime incomplete — ${label} not found at ${p}`);
  }
}

/**
 * Lint a project. Returns { ok, errors: [{file, code, message, fixHint}], warnings }.
 */
export async function lintProject(dir) {
  const { stdout, stderr } = await hf(['lint', '--json'], { cwd: dir, timeoutMs: 120_000 });
  let report;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    throw new Error(`hyperframes lint produced no JSON: ${(stderr || stdout).slice(0, 300)}`);
  }
  const findings = report.findings ?? [];
  return {
    ok: report.errorCount === 0,
    errors: findings.filter(f => f.severity === 'error'),
    warnings: findings.filter(f => f.severity === 'warning'),
  };
}

/**
 * `hyperframes check` — lint + runtime (console errors, missing plugins) +
 * layout (overlaps, overflow, text fit) + contrast, sampled in a real
 * browser. Returns a flat list of actionable findings:
 * [{ stage, severity, code, message, fixHint, sourceFile, time, text }].
 * Studio-ergonomics warnings and info-level notes are dropped.
 */
const ACTIONABLE_WARNINGS = new Set(['console_warning', 'console_error', 'gsap_css_transform_conflict']);
export async function checkProject(dir) {
  const { stdout, stderr } = await hf(['check', '--json'], { cwd: dir, timeoutMs: 300_000 });
  let report;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    throw new Error(`hyperframes check produced no JSON: ${(stderr || stdout).slice(0, 300)}`);
  }
  const out = [];
  for (const stage of ['lint', 'runtime', 'layout', 'contrast', 'motion']) {
    for (const f of report[stage]?.findings ?? []) {
      if (f.severity !== 'error' && !(f.severity === 'warning' && ACTIONABLE_WARNINGS.has(f.code))) continue;
      out.push({
        stage, severity: f.severity, code: f.code, message: f.message, fixHint: f.fixHint,
        sourceFile: f.sourceFile ?? f.file ?? '', time: f.firstSeen ?? f.time, text: f.text,
      });
    }
  }
  return { ok: out.length === 0, findings: out };
}

/** Render index.html to an MP4. Returns the output path. */
export async function renderProject(dir, outPath, { quality = 'delivery', fps = 30 } = {}) {
  const { code, stdout, stderr, killed } = await hf(
    ['render', '--output', outPath, '--quality', quality, '--fps', String(fps), '--quiet'],
    { cwd: dir, timeoutMs: 1_800_000 },
  );
  if (code !== 0 || !existsSync(outPath)) {
    throw new Error(`hyperframes render failed${killed ? ' (timed out)' : ''}: ${(stderr || stdout).slice(-600)}`);
  }
  return outPath;
}

/**
 * Word-level transcript of a media file via `hyperframes transcribe`
 * (whisper.cpp, local). Writes transcript.json into `workDir`.
 * Returns [{ text, start, end }] — empty array if transcription fails, so
 * a caption problem never sinks the whole render.
 */
export async function transcribe(workDir, mediaFile) {
  const { code } = await hf(['transcribe', mediaFile, '--dir', workDir, '--model', 'small.en', '--language', 'en'], { cwd: workDir, timeoutMs: 300_000 });
  const out = join(workDir, 'transcript.json');
  if (code !== 0 || !existsSync(out)) return [];
  try {
    const data = JSON.parse(readFileSync(out, 'utf8'));
    const words = Array.isArray(data) ? data : (data.words ?? []);
    return words
      .filter(w => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map(w => ({ text: w.text.trim(), start: w.start, end: w.end }))
      .filter(w => w.text);
  } catch {
    return [];
  }
}

/** Media duration in seconds via ffprobe. */
export async function probeDuration(file) {
  const { code, stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  const d = parseFloat(stdout);
  if (code !== 0 || !Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}
