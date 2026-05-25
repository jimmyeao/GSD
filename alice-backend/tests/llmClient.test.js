import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamCompletion, complete, LLMUnavailableError } from '../src/agents/llmClient.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSSEStream(tokens, done = true) {
  const lines = tokens.map(t =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`
  );
  if (done) lines.push('data: [DONE]\n');
  const body = lines.join('\n');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

function mockFetch(status, stream) {
  return mock.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    text: async () => 'error body',
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('streamCompletion', () => {
  afterEach(() => mock.restoreAll());

  it('yields tokens from a valid SSE stream', async () => {
    const tokens = ['Hello', ', ', 'world', '!'];
    globalThis.fetch = mockFetch(200, makeSSEStream(tokens));

    const results = [];
    for await (const token of streamCompletion('http://localhost:8001', 'model', [])) {
      results.push(token);
    }

    assert.deepEqual(results, tokens);
  });

  it('throws LLMUnavailableError when fetch throws ECONNREFUSED', async () => {
    globalThis.fetch = mock.fn(async () => {
      const err = new Error('ECONNREFUSED');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    });

    await assert.rejects(
      async () => {
        for await (const _ of streamCompletion('http://localhost:8001', 'model', [])) {}
      },
      (err) => {
        assert.equal(err.name, 'LLMUnavailableError');
        return true;
      },
    );
  });

  it('throws an error on non-2xx HTTP status', async () => {
    globalThis.fetch = mockFetch(500, makeSSEStream([]));

    await assert.rejects(
      async () => {
        for await (const _ of streamCompletion('http://localhost:8001', 'model', [])) {}
      },
      /LLM API 500/,
    );
  });

  it('skips lines that are not data: prefixed', async () => {
    const raw = 'ping\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n';
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); },
      }),
    }));

    const results = [];
    for await (const token of streamCompletion('http://localhost:8001', 'model', [])) {
      results.push(token);
    }
    assert.deepEqual(results, ['hi']);
  });

  it('skips malformed JSON data lines without throwing', async () => {
    const raw = 'data: not-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n';
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); },
      }),
    }));

    const results = [];
    for await (const token of streamCompletion('http://localhost:8001', 'model', [])) {
      results.push(token);
    }
    assert.deepEqual(results, ['ok']);
  });
});

describe('complete', () => {
  afterEach(() => mock.restoreAll());

  it('returns the assistant message content', async () => {
    // complete() uses the native Ollama /api/chat format
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '  CoderAgent  ' } }),
    }));

    const result = await complete('http://localhost:8001', 'model', []);
    assert.equal(result, 'CoderAgent');
  });

  it('throws LLMUnavailableError when fetch throws', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('ECONNREFUSED'); });

    await assert.rejects(
      () => complete('http://localhost:8001', 'model', []),
      (err) => { assert.equal(err.name, 'LLMUnavailableError'); return true; },
    );
  });
});
