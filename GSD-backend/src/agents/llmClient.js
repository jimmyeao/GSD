/**
 * LLM client supporting both:
 *   - OpenAI-compat  /v1/chat/completions  (default, streaming with reasoning)
 *   - Ollama native  /api/chat             (used when noThink:true — think:false works here)
 */

/**
 * Stream completion tokens.
 * When opts.noThink is true, uses Ollama's native /api/chat with think:false
 * so Qwen3 skips its chain-of-thought phase entirely.
 *
 * @param {string} endpoint  Base URL e.g. http://localhost:11434
 * @param {string} model     Model name
 * @param {Array}  messages  Array of {role, content}
 * @param {object} opts      signal, temperature, maxTokens, noThink, onThinking
 * @yields {string} token
 */
export async function* streamCompletion(endpoint, model, messages, opts = {}) {
  if (opts.noThink) {
    yield* streamOllamaNative(endpoint, model, messages, opts);
  } else {
    yield* streamOpenAICompat(endpoint, model, messages, opts);
  }
}

// ── OpenAI-compat streaming (/v1/chat/completions) ────────────────────
async function* streamOpenAICompat(endpoint, model, messages, opts) {
  const url = `${endpoint}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    // Qwen3 consumes tokens on reasoning before content — use a high ceiling
    max_tokens: opts.maxTokens ?? 8192,
  });

  const response = await fetchOrThrow(url, body, opts.signal);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        if (!data) continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        const reasoning = parsed.choices?.[0]?.delta?.reasoning;
        const token     = parsed.choices?.[0]?.delta?.content;
        if (reasoning) opts.onThinking?.();
        if (token) yield token;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Ollama native streaming (/api/chat with think:false) ──────────────
async function* streamOllamaNative(endpoint, model, messages, opts) {
  const url = `${endpoint}/api/chat`;
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    think: false,
    options: { temperature: opts.temperature ?? 0.7, num_predict: opts.maxTokens ?? 4096 },
  });

  const response = await fetchOrThrow(url, body, opts.signal);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }

        const token = parsed.message?.content;
        if (token) yield token;
        if (parsed.done) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Non-streaming single-shot completion — used for routing decisions.
 * Always uses the native Ollama API with think:false for fast responses.
 */
export async function complete(endpoint, model, messages, opts = {}) {
  const url = `${endpoint}/api/chat`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, think: false, options: { num_predict: opts.numPredict ?? 32 } }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new LLMUnavailableError(endpoint, err.message);
  }
  if (!response.ok) throw new Error(`LLM API ${response.status}`);
  const json = await response.json();
  return json.message?.content?.trim() ?? '';
}

// ── Shared helpers ────────────────────────────────────────────────────

async function fetchOrThrow(url, body, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    });
  } catch (err) {
    throw new LLMUnavailableError(url, err.message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response;
}

export class LLMUnavailableError extends Error {
  constructor(endpoint, cause) {
    super(`LLM backend unavailable at ${endpoint}: ${cause}`);
    this.name = 'LLMUnavailableError';
    this.endpoint = endpoint;
  }
}
