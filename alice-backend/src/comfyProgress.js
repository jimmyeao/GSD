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
 * @returns {Function} cleanup  - Call to close the WebSocket
 */
export function monitorProgress(endpoint, clientId, promptId, onProgress) {
  const wsUrl = endpoint.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
  let ws;
  let closed = false;
  let currentNode = null;
  const nodeNames = {};

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
            onProgress(`Sampling: ${bar} ${pct}% (${value}/${max})`);
          }
          break;
        }

        case 'execution_error':
          onProgress(`Error: ${msg.data?.exception_message || 'Unknown error'}`);
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
