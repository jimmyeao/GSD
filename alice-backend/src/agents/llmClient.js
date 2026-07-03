/**
 * LLM client — OpenAI-compat only (/v1/chat/completions).
 *
 * All Alice model roles (general/coder/mail) are served behind a LiteLLM
 * gateway in front of vLLM, which only speaks OpenAI-compat — there is no
 * Ollama-native /api/chat endpoint anymore. `opts.noThink` now maps to
 * `reasoning_effort: 'low'` in the request body (vLLM's reasoning-capable
 * backends read this as an extra field; harmless to send even if a given
 * backend ignores it).
 */

import { config } from '../config.js';

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (config.llmGatewayKey) headers.Authorization = `Bearer ${config.llmGatewayKey}`;
  return headers;
}

/**
 * Stream completion tokens from /v1/chat/completions.
 *
 * @param {string} endpoint  Base URL e.g. http://localhost:4000
 * @param {string} model     Model name (a LiteLLM alias, e.g. "alice-general")
 * @param {Array}  messages  Array of {role, content}
 * @param {object} opts      signal, temperature, maxTokens, noThink, onThinking
 * @yields {string} token
 */
export async function* streamCompletion(endpoint, model, messages, opts = {}) {
  yield* streamOpenAICompat(endpoint, model, messages, opts);
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
    ...(opts.noThink ? { reasoning_effort: 'low' } : {}),
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

        // LiteLLM normalises every backend's reasoning field to
        // `reasoning_content` — fall back to the raw `reasoning` key in
        // case of a direct (non-gateway) vLLM endpoint.
        const reasoning = parsed.choices?.[0]?.delta?.reasoning_content ?? parsed.choices?.[0]?.delta?.reasoning;
        const token     = parsed.choices?.[0]?.delta?.content;
        if (reasoning) opts.onThinking?.();
        if (token) yield token;
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
 * @param {string} endpoint
 * @param {string} model
 * @param {Array}  messages   May include role:'tool' entries with tool_call_id + content.
 * @param {object} opts       { signal, numPredict?, temperature?, tools, toolChoice?, noThink? }
 * @returns {Promise<{content:string|null, tool_calls:Array|null, finish_reason:string|null}>}
 */
export async function completeWithTools(endpoint, model, messages, opts = {}) {
  const url = `${endpoint}/v1/chat/completions`;
  const body = {
    model,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.numPredict ?? 2048,
    ...(opts.noThink ? { reasoning_effort: 'low' } : {}),
  };
  if (Array.isArray(opts.tools) && opts.tools.length) {
    body.tools = opts.tools;
  }
  if (opts.toolChoice) {
    body.tool_choice = opts.toolChoice;
  }

  async function call(callBody = body) {
    // Combine user-abort with a per-request timeout so a hung backend doesn't
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
        headers: authHeaders(),
        body: JSON.stringify(callBody),
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
          model: callBody.model,
          messageRoles: callBody.messages?.map(m => m.role),
          lastMsgKeys: callBody.messages ? Object.keys(callBody.messages[callBody.messages.length - 1] || {}) : [],
          toolCount: callBody.tools?.length || 0,
          hasToolCallsInLast: !!(callBody.messages?.[callBody.messages.length - 1]?.tool_calls),
        };
        console.warn('[llm] API %s: %s | shape=%j', resp.status, text.slice(0, 200), shape);
      }
      throw new Error(`LLM API ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  let json;
  try {
    json = await call();
  } catch (err) {
    throw err;
  }

  const msg = json.choices?.[0]?.message || {};
  const finishReason = json.choices?.[0]?.finish_reason || null;

  let toolCalls = null;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    toolCalls = [];
    let needRetry = false;
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      const fn = tc.function || {};
      let args = fn.arguments;
      // OpenAI-compat servers always return arguments as a JSON string.
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
      const retryBody = { ...body, messages: retryMessages };
      let retryJson;
      try {
        retryJson = await call(retryBody);
      } catch (err) {
        throw err;
      }
      const rm = retryJson.choices?.[0]?.message || {};
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
        finish_reason: retryJson.choices?.[0]?.finish_reason || null,
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
 * Non-streaming single-shot completion — used for routing decisions,
 * planning, and prompt enhancement.
 */
export async function complete(endpoint, model, messages, opts = {}) {
  const url = `${endpoint}/v1/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.4,
        // Reasoning models spend tokens thinking before ever emitting the
        // real answer — verified empirically that 32 (fine for Ollama's old
        // non-reasoning routing model) leaves 0 room and returns empty content
        // on every call against Qwen3.6/Nemotron. 300 gave a reliable margin.
        max_tokens: opts.numPredict ?? 300,
        ...(opts.noThink ? { reasoning_effort: 'low' } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new LLMUnavailableError(endpoint, err.message);
  }
  if (!response.ok) throw new Error(`LLM API ${response.status}`);
  const json = await response.json();
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

// ── Shared helpers ────────────────────────────────────────────────────

async function fetchOrThrow(url, body, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
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
