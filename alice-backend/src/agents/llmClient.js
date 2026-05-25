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
  const options = {
    temperature: opts.temperature ?? 0.7,
    num_predict: opts.maxTokens ?? 4096,
    // Ollama defaults num_ctx tiny (2k-4k) unless set; tool loops and big
    // projects exceed it silently otherwise. Callers can override via numCtx.
    ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
  };
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    think: false,
    options,
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
 * Send a chat completion request that may return tool_calls.
 * Non-streaming (for tool-calling loops where you need the whole response).
 *
 * Ollama's /api/chat accepts `tools` in OpenAI format and returns
 * `message.tool_calls` when the model decides to call a tool.
 *
 * @param {string} endpoint
 * @param {string} model
 * @param {Array}  messages   May include role:'tool' entries with tool_call_id + content.
 * @param {object} opts       { signal, numPredict?, temperature?, tools, toolChoice? }
 * @returns {Promise<{content:string|null, tool_calls:Array|null, finish_reason:string|null}>}
 */
export async function completeWithTools(endpoint, model, messages, opts = {}) {
  const url = `${endpoint}/api/chat`;
  const payload = {
    model,
    messages,
    // Use streaming: Ollama's non-streaming path has a 5-minute HTTP write
    // timeout; streaming resets on each chunk so long generations complete.
    stream: true,
    think: false,
    options: {
      temperature: opts.temperature ?? 0.4,
      num_predict: opts.numPredict ?? 2048,
      // num_ctx is NOT forced here. Setting it explicitly to 32k dramatically
      // slows qwen3:32b inference (bigger KV cache, slower attention) — and
      // with compacted list_messages output the real context stays small.
      // If a specific caller needs more, pass opts.numCtx.
      ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
    },
  };
  if (Array.isArray(opts.tools) && opts.tools.length) {
    payload.tools = opts.tools;
  }
  if (opts.toolChoice) {
    payload.tool_choice = opts.toolChoice;
  }

  async function call(callPayload = payload) {
    // Combine user-abort with a per-request timeout so a hung Ollama doesn't
    // burn indefinitely; 5 min accommodates slow prompt-eval on 30B+ models
    // with large tool-call histories while still bailing on a real wedge.
    const timeoutSignal = AbortSignal.timeout(300_000);
    const combined = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callPayload),
        signal: combined,
      });
    } catch (err) {
      const elapsed = Date.now() - t0;
      const timedOut = timeoutSignal.aborted;
      console.warn('[llm] fetch failed after %dms (timeout=%s user-abort=%s): %s',
        elapsed, timedOut, opts.signal?.aborted ?? false, err.message);
      throw new LLMUnavailableError(endpoint, err.message);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (resp.status >= 400 && resp.status < 500) {
        const shape = {
          model: callPayload.model,
          messageRoles: callPayload.messages?.map(m => m.role),
          lastMsgKeys: callPayload.messages ? Object.keys(callPayload.messages[callPayload.messages.length - 1] || {}) : [],
          toolCount: callPayload.tools?.length || 0,
          hasToolCallsInLast: !!(callPayload.messages?.[callPayload.messages.length - 1]?.tool_calls),
        };
        console.warn('[llm] API %s: %s | shape=%j', resp.status, text.slice(0, 200), shape);
      }
      throw new Error(`LLM API ${resp.status}: ${text.slice(0, 200)}`);
    }

    // Stream: Ollama emits NDJSON chunks. Accumulate content + capture tool_calls
    // + done_reason, then return the same shape as the old non-streaming call.
    let accumContent = '';
    let accumToolCalls = null;
    let doneReason = null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleChunk = (obj) => {
      const m = obj.message || {};
      if (typeof m.content === 'string' && m.content) accumContent += m.content;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) accumToolCalls = m.tool_calls;
      if (obj.done) doneReason = obj.done_reason || 'stop';
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handleChunk(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
    if (buffer.trim()) {
      try { handleChunk(JSON.parse(buffer)); } catch { /* ignore */ }
    }
    return {
      message: { content: accumContent, tool_calls: accumToolCalls },
      done: true,
      done_reason: doneReason,
    };
  }

  let json;
  try {
    json = await call();
  } catch (err) {
    throw err;
  }

  const msg = json.message || {};
  const finishReason = json.done_reason || (json.done ? 'stop' : null);

  let toolCalls = null;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    toolCalls = [];
    let needRetry = false;
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      const fn = tc.function || {};
      let args = fn.arguments;
      // Ollama may return arguments as an object or a JSON string — normalise to an object
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          needRetry = true;
          break;
        }
      } else if (args == null) {
        args = {};
      }
      toolCalls.push({
        id: tc.id || `call_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fn.name || '',
          arguments: args,
        },
      });
    }

    if (needRetry) {
      // Retry once — stronger hint to produce valid JSON
      const retryMessages = [...messages, {
        role: 'system',
        content: 'Your previous tool call had invalid JSON in the arguments field. Retry with strictly valid JSON arguments.',
      }];
      const retryPayload = { ...payload, messages: retryMessages };
      let retryJson;
      try {
        retryJson = await call(retryPayload);
      } catch (err) {
        throw err;
      }
      const rm = retryJson.message || {};
      toolCalls = null;
      if (Array.isArray(rm.tool_calls) && rm.tool_calls.length) {
        toolCalls = [];
        for (let i = 0; i < rm.tool_calls.length; i++) {
          const tc = rm.tool_calls[i];
          const fn = tc.function || {};
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          } else if (args == null) {
            args = {};
          }
          toolCalls.push({
            id: tc.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: { name: fn.name || '', arguments: args },
          });
        }
      }
      return {
        content: rm.content ?? null,
        tool_calls: toolCalls,
        finish_reason: retryJson.done_reason || (retryJson.done ? 'stop' : null),
      };
    }
  }

  return {
    content: msg.content ?? null,
    tool_calls: toolCalls,
    finish_reason: finishReason,
  };
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
