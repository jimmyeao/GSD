/**
 * ComfyUI WebSocket progress monitor.
 * Connects to ComfyUI's WebSocket and forwards generation progress events.
 */

import WebSocket from 'ws';

/**
 * Monitor ComfyUI progress for a specific prompt via WebSocket.
 * Returns a cleanup function to close the connection.
 *
 * @param {string} endpoint   - ComfyUI base URL (http://localhost:8188)
 * @param {string} clientId   - Client ID used when queuing the prompt
 * @param {string} promptId   - The prompt_id to monitor
 * @param {Function} onProgress - Called with progress string messages
 * @param {Function} [onNodeExecuted] - Called (nodeId, output) whenever an
 *   OUTPUT_NODE finishes, e.g. { text: [...] } for PreviewAny. Fires in real
 *   time per-node — unlike /history, which only gets an entry once the whole
 *   prompt finishes, this is the only way to read an intermediate output
 *   node's result while the rest of a long-running graph is still executing.
 * @returns {Function} cleanup  - Call to close the WebSocket
 */
export function monitorProgress(endpoint, clientId, promptId, onProgress, onNodeExecuted) {
  const wsUrl = endpoint.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
  let ws;
  let closed = false;
  let currentNode = null;
  const nodeNames = {};

  // ETA is estimated from sampling progress only (value/max steps) — it
  // covers just the sampler, not model loading, VAE decode, or upscaling,
  // so it's labeled "sampling" rather than implying a total-job estimate.
  let firstProgressAt = null;
  let firstProgressValue = null;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return () => {};
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Only process events for our prompt
      if (msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;

      switch (msg.type) {
        case 'execution_start':
          onProgress('Starting generation...');
          break;

        case 'executing': {
          const nodeId = msg.data?.node;
          if (nodeId && nodeId !== currentNode) {
            currentNode = nodeId;
            // Map some known node types to friendly names
            const name = nodeNames[nodeId] || `Processing node ${nodeId}`;
            onProgress(name);
          }
          if (nodeId === null) {
            // Execution complete
            onProgress('Finalising...');
          }
          break;
        }

        case 'progress': {
          const { value, max } = msg.data || {};
          if (value != null && max != null) {
            const pct = Math.round((value / max) * 100);
            const bar = progressBar(value, max);

            if (firstProgressAt === null) {
              firstProgressAt = Date.now();
              firstProgressValue = value;
            }
            const elapsedMs = Date.now() - firstProgressAt;
            const stepsDone = value - firstProgressValue;
            let etaStr = '';
            if (stepsDone > 0 && value < max) {
              const msPerStep = elapsedMs / stepsDone;
              etaStr = `, ~${formatDuration(msPerStep * (max - value))} left`;
            }
            onProgress(`Sampling: ${bar} ${pct}% (${value}/${max}${etaStr})`);
          }
          break;
        }

        case 'execution_error':
          onProgress(`Error: ${msg.data?.exception_message || 'Unknown error'}`);
          break;

        case 'executed':
          if (onNodeExecuted) onNodeExecuted(msg.data?.node, msg.data?.output);
          break;
      }
    } catch { /* ignore parse errors */ }
  });

  ws.on('error', () => { /* ignore connection errors */ });
  ws.on('close', () => { closed = true; });

  return () => {
    if (!closed && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
}

function progressBar(value, max) {
  const width = 20;
  const filled = Math.round((value / max) * width);
  return '`[' + '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled) + ']`';
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
