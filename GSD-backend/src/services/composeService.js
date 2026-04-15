import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Check if a docker-compose file exists in the workspace.
 * Checks for: docker-compose.yml, docker-compose.yaml, compose.yml, compose.yaml
 */
export function findComposeFile(workspacePath) {
  const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const name of names) {
    const p = join(workspacePath, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Run docker compose up with streaming output.
 * @param {string} workspacePath - absolute path to workspace (build context)
 * @param {string} projectName - compose project name for isolation (e.g. 'gsd-2-1')
 * @param {object} opts
 * @param {function} opts.onOutput - callback(string) for stdout/stderr lines
 * @param {object} opts.env - extra env vars to pass to compose
 * @returns {Promise<{code: number}>} exit code
 */
export function composeUp(workspacePath, projectName, opts = {}) {
  return _runCompose(workspacePath, projectName, ['up', '-d', '--build', '--remove-orphans'], opts);
}

/**
 * Run docker compose down (stop + remove containers + networks).
 */
export function composeDown(workspacePath, projectName, opts = {}) {
  return _runCompose(workspacePath, projectName, ['down', '--remove-orphans', '-v'], opts);
}

/**
 * Get status of compose services.
 * Returns parsed JSON array of service statuses.
 */
export async function composePs(workspacePath, projectName) {
  const output = [];
  await _runCompose(workspacePath, projectName, ['ps', '--format', 'json'], {
    onOutput: (line) => output.push(line),
  });
  // docker compose ps --format json outputs one JSON object per line
  const services = [];
  for (const line of output) {
    try { services.push(JSON.parse(line.trim())); } catch { /* skip non-json */ }
  }
  return services;
}

/**
 * Stream logs from all compose services.
 * @returns {ChildProcess} - caller can listen to stdout/stderr and kill it
 */
export function composeLogs(workspacePath, projectName) {
  const args = ['compose', '-p', projectName, 'logs', '-f', '--tail', '100'];
  const proc = spawn('docker', args, { cwd: workspacePath });
  return proc;
}

/** Internal: run a docker compose command with streaming output. */
function _runCompose(workspacePath, projectName, composeArgs, opts = {}) {
  const { onOutput = () => {}, env = {} } = opts;
  const args = ['compose', '-p', projectName, ...composeArgs];

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, {
      cwd: workspacePath,
      env: { ...process.env, ...env },
    });

    proc.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line => onOutput(line));
    });
    proc.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line => onOutput(line));
    });

    proc.on('close', (code) => resolve({ code }));
    proc.on('error', reject);
  });
}
