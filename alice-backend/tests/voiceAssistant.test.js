import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  plainSpeech, parseChatRequest, pickVoiceAgent, runVoiceTurn, HeadlessSocket,
  handleAssistantCompletion, completionBody, UNSUPPORTED_REPLY,
} from '../src/agents/voiceAssistant.js';

const anon = { id: 0 };

function fakeRes() {
  const res = {
    statusCode: 200, body: null, chunks: [], ended: false, writableEnded: false, destroyed: false, headers: {}, listeners: {},
    status(c) { this.statusCode = c; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    json(b) { this.body = b; this.ended = this.writableEnded = true; return this; },
    write(c) { this.chunks.push(c); return true; },
    end() { this.ended = this.writableEnded = true; },
    on(ev, fn) { this.listeners[ev] = fn; return this; },
  };
  return res;
}

describe('plainSpeech', () => {
  it('turns markdown links into their text and drops bare URLs', () => {
    assert.equal(plainSpeech('According to [the BBC](https://bbc.co.uk/a), rain is due. See https://x.com/y now.'),
      'According to the BBC, rain is due. See now.');
  });
  it('strips emphasis, headings, bullets and code fences', () => {
    assert.equal(plainSpeech('# Title\n- **bold** item\n- plain\n```js\nconst a=1\n```\ndone'), 'Title bold item plain done');
  });
  it('keeps snake_case words intact', () => {
    assert.equal(plainSpeech('Set max_num_seqs to four'), 'Set max_num_seqs to four');
  });
  it('handles null/undefined', () => {
    assert.equal(plainSpeech(null), '');
  });
});

describe('parseChatRequest', () => {
  it('takes the last user message and prior turns as history, ignoring system messages', () => {
    const r = parseChatRequest({ messages: [
      { role: 'system', content: 'HA prompt' },
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'weather?' },
    ] });
    assert.equal(r.content, 'weather?');
    assert.deepEqual(r.history, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  });
  it('accepts content-part arrays', () => {
    const r = parseChatRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] });
    assert.equal(r.content, 'a b');
  });
  it('rejects bodies that do not end with a user message', () => {
    assert.ok(parseChatRequest({ messages: [] }).error);
    assert.ok(parseChatRequest({}).error);
    assert.ok(parseChatRequest({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }).error);
    assert.ok(parseChatRequest({ messages: [{ role: 'user', content: '   ' }] }).error);
  });
  it('caps input length and history depth', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
    msgs.push({ role: 'user', content: 'x'.repeat(5000) });
    const r = parseChatRequest({ messages: msgs });
    assert.equal(r.content.length, 2000);
    assert.equal(r.history.length, 8);
  });
});

describe('pickVoiceAgent', () => {
  it('routes weather/news to WebAgent and chat to AssistantAgent', () => {
    assert.equal(pickVoiceAgent("What's the weather like today?"), 'WebAgent');
    assert.equal(pickVoiceAgent('Give me the latest headlines'), 'WebAgent');
    assert.equal(pickVoiceAgent('How do I restart a service on Linux?'), 'AssistantAgent');
  });
  it('returns null for agents that need a screen', () => {
    assert.equal(pickVoiceAgent('Generate an image of a server room'), null);
    assert.equal(pickVoiceAgent('Check my inbox for unread email'), null);
  });
});

describe('runVoiceTurn', () => {
  it('runs WebAgent headless and returns flattened speech', async () => {
    const runWebAgent = async ({ socket, convId, user }) => {
      assert.equal(convId, null);
      assert.equal(user.id, 0);
      socket.emit('thinking', {});
      socket.emit('token', { token: 'According to [the BBC](https://bbc.co.uk/x), ' });
      socket.emit('token', { token: 'it is raining.' });
      socket.emit('done', { agent: 'WebAgent' });
    };
    const r = await runVoiceTurn({ content: "What's the weather today?" }, { runWebAgent, user: anon });
    assert.deepEqual(r, { text: 'According to the BBC, it is raining.', agent: 'WebAgent' });
  });
  it('surfaces a WebAgent error when it produced no text', async () => {
    const runWebAgent = async ({ socket }) => { socket.emit('error', { message: 'boom' }); };
    await assert.rejects(runVoiceTurn({ content: 'weather in Leeds' }, { runWebAgent, user: anon }), /boom/);
  });
  it('forwards an abort to WebAgent as stop:stream', async () => {
    const ac = new AbortController();
    let stopped = false;
    const runWebAgent = ({ socket }) => new Promise(resolve => {
      socket.once('stop:stream', () => { stopped = true; resolve(); });
      ac.abort();
    });
    await runVoiceTurn({ content: 'weather today', signal: ac.signal }, { runWebAgent, user: anon });
    assert.equal(stopped, true);
  });
  it('answers general questions via the LLM with voice rules and history', async () => {
    let seen;
    const complete = async (_e, _m, messages, opts) => { seen = { messages, opts }; return '**Restart** it with systemctl.'; };
    const r = await runVoiceTurn({ content: 'How do I restart nginx?', history: [{ role: 'user', content: 'hi' }] }, { complete, user: anon });
    assert.equal(r.agent, 'AssistantAgent');
    assert.equal(r.text, 'Restart it with systemctl.');
    assert.match(seen.messages[0].content, /spoken aloud/);
    assert.equal(seen.messages.at(-1).content, 'How do I restart nginx?');
    assert.equal(seen.opts.noThink, true);
  });
  it('refuses screen-only agents without calling anything', async () => {
    const boom = async () => { throw new Error('should not be called'); };
    const r = await runVoiceTurn({ content: 'Generate an image of a cat' }, { complete: boom, runWebAgent: boom, user: anon });
    assert.deepEqual(r, { text: UNSUPPORTED_REPLY, agent: null });
  });
});

describe('HeadlessSocket', () => {
  it('collects tokens and records errors', () => {
    const s = new HeadlessSocket();
    s.emit('token', { token: 'a' }); s.emit('token', { token: 'b' }); s.emit('error', { message: 'x' });
    assert.equal(s.text, 'ab');
    assert.equal(s.errorMessage, 'x');
  });
});

describe('handleAssistantCompletion', () => {
  const deps = { user: anon, complete: async () => 'Hello there.' };
  it('returns an OpenAI chat.completion', async () => {
    const res = fakeRes();
    await handleAssistantCompletion({ body: { model: 'alice-assistant', messages: [{ role: 'user', content: 'tell me a fact' }] } }, res, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.object, 'chat.completion');
    assert.equal(res.body.choices[0].message.content, 'Hello there.');
  });
  it('streams SSE chunks ending in [DONE] when stream is requested', async () => {
    const res = fakeRes();
    await handleAssistantCompletion({ body: { model: 'alice-assistant', stream: true, messages: [{ role: 'user', content: 'tell me a fact' }] } }, res, deps);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    const joined = res.chunks.join('');
    assert.match(joined, /"content":"Hello there\."/);
    assert.ok(joined.endsWith('data: [DONE]\n\n'));
  });
  it('400s on a bad body', async () => {
    const res = fakeRes();
    await handleAssistantCompletion({ body: { model: 'alice-assistant', messages: [] } }, res, deps);
    assert.equal(res.statusCode, 400);
  });
  it('500s without leaking the internal error message', async () => {
    const res = fakeRes();
    await handleAssistantCompletion({ body: { model: 'alice-assistant', messages: [{ role: 'user', content: 'tell me a fact' }] } }, res,
      { user: anon, complete: async () => { throw new Error('secret internal detail'); } });
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  });
  it('completionBody has the OpenAI shape', () => {
    const b = completionBody('hi');
    assert.equal(b.choices[0].finish_reason, 'stop');
    assert.equal(b.model, 'alice-assistant');
  });
});
