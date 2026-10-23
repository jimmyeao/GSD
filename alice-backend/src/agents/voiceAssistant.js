/**
 * Voice assistant endpoint — lets Home Assistant (or any OpenAI-compatible
 * voice client) talk to Alice's agents as a conversation agent.
 *
 * Exposed as the model `alice-assistant` on POST /v1/chat/completions (see
 * routes/openai.js). Unlike the other models there, which are a plain proxy
 * to the LLM, this runs a real Alice agent and returns its spoken-style answer.
 *
 * Deliberately narrow:
 *   - Only agents that make sense with no screen: WebAgent (weather, news,
 *     search, read a page — read-only) and AssistantAgent (general chat).
 *     Anything else (mail with its approval flow, image/video/music, code…)
 *     gets a short spoken "use the Alice screen" reply instead of running.
 *   - Routing is keyword-only (no extra LLM call) to keep latency down.
 *   - Stateless: Home Assistant resends the conversation in `messages`, so
 *     nothing is persisted. Memory facts are read only when
 *     ALICE_VOICE_USER_EMAIL names an existing Alice user.
 *   - The answer is flattened to plain speech (no markdown, no URLs) because a
 *     TTS engine reads every character.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { complete, LLMUnavailableError } from './llmClient.js';
import { AGENT_REGISTRY } from './registry.js';
import { routeByKeyword } from '../router.js';
import { getMemoryContext } from '../memory.js';
import { runWebAgent } from './webAgent.js';

export const ASSISTANT_MODEL = 'alice-assistant';

const MAX_INPUT_CHARS = 2000;
const MAX_HISTORY = 8;
const TURN_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 3;

export const VOICE_AGENTS = new Set(['WebAgent', 'AssistantAgent']);
export const UNSUPPORTED_REPLY = "That one needs the Alice screen, so I can't do it by voice yet.";

const VOICE_RULES = `Your reply is spoken aloud by a voice, so write for the ear: plain flowing sentences only.
No markdown, lists, headings, tables, code blocks or URLs. Keep it to one to three short sentences unless asked for more.
Use UK English. If you do not know something, say so briefly.`;

let inFlight = 0;

/** Flatten markdown-ish model output to text a TTS engine can read. */
export function plainSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)\s]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|\*)(?=\S)([^*\n]+?)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const partsToText = (c) =>
  typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join(' ')
      : '';

/** Validate an OpenAI chat body → { content, history } or { error }. */
export function parseChatRequest(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const convo = msgs
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: partsToText(m.content).trim() }))
    .filter(m => m.content);
  const last = convo[convo.length - 1];
  if (!last || last.role !== 'user') return { error: 'messages must end with a non-empty user message' };
  return {
    content: last.content.slice(0, MAX_INPUT_CHARS),
    history: convo.slice(0, -1).slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content.slice(0, MAX_INPUT_CHARS) })),
  };
}

/** Which agent handles this utterance, or null if it is not a voice agent. */
export function pickVoiceAgent(content) {
  const agent = routeByKeyword(content);
  return VOICE_AGENTS.has(agent) ? agent : null;
}

/** Minimal socket stand-in so agents written for Socket.IO run headless. */
export class HeadlessSocket extends EventEmitter {
  constructor() { super(); this.tokens = []; this.errorMessage = null; }
  emit(event, payload) {
    if (event === 'token') this.tokens.push(payload?.token ?? '');
    // An EventEmitter throws on an unhandled 'error' event; record it instead.
    else if (event === 'error') { this.errorMessage = payload?.message ?? 'unknown error'; return true; }
    return super.emit(event, payload);
  }
  get text() { return this.tokens.join(''); }
}

function voiceUser() {
  const email = process.env.ALICE_VOICE_USER_EMAIL;
  if (email) {
    const row = db.prepare('SELECT id, email, display_name, role FROM users WHERE email = ?').get(email);
    if (row) return row;
  }
  return { id: 0 }; // anonymous: no memory facts, nothing persisted
}

/**
 * Run one voice turn. `deps` are injectable for tests.
 * @returns {Promise<{ text: string, agent: string|null }>}
 */
export async function runVoiceTurn({ content, history = [], signal }, deps = {}) {
  const run = deps.runWebAgent ?? runWebAgent;
  const llm = deps.complete ?? complete;
  const agent = pickVoiceAgent(content);
  if (!agent) return { text: UNSUPPORTED_REPLY, agent: null };

  const user = deps.user ?? voiceUser();

  if (agent === 'WebAgent') {
    const socket = new HeadlessSocket();
    const onAbort = () => socket.emit('stop:stream');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await run({ socket, user, content, history, convId: null });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (socket.errorMessage && !socket.text) throw new Error(socket.errorMessage);
    return { text: plainSpeech(socket.text), agent };
  }

  const def = AGENT_REGISTRY.AssistantAgent;
  const memory = user.id ? getMemoryContext(user.id, content) : '';
  const messages = [
    { role: 'system', content: `${def.systemPrompt}\n\n${VOICE_RULES}` },
    ...(memory ? [{ role: 'system', content: memory }] : []),
    ...history,
    { role: 'user', content },
  ];
  const model = config.models[def.model] ?? config.models.general;
  const raw = await llm(model.endpoint, model.model, messages, { signal, noThink: true, numPredict: 700, temperature: 0.5 });
  return { text: plainSpeech(raw), agent };
}

export function completionBody(text, model = ASSISTANT_MODEL) {
  return {
    id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendSse(res, text, model) {
  const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(chunk({ role: 'assistant' }));
  res.write(chunk({ content: text }));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

const apiError = (res, status, message, type = 'invalid_request_error') =>
  res.status(status).json({ error: { message, type } });

/** Express handler for POST /v1/chat/completions when model === alice-assistant. */
export async function handleAssistantCompletion(req, res, deps = {}) {
  const parsed = parseChatRequest(req.body);
  if (parsed.error) return apiError(res, 400, parsed.error);
  if (inFlight >= MAX_CONCURRENT) return apiError(res, 429, 'Alice is busy with other voice requests', 'rate_limit_error');

  inFlight++;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  try {
    const { text, agent } = await runVoiceTurn({ ...parsed, signal: abort.signal }, deps);
    // Log the routing outcome only — what someone says aloud at home is not journal material.
    console.log(`[voice] ${agent ?? 'unsupported'}: ${parsed.content.length} chars in → ${text.length} chars out`);
    const reply = text || "Sorry, I didn't get an answer back. Please try again.";
    if (req.body.stream) return sendSse(res, reply, ASSISTANT_MODEL);
    return res.json(completionBody(reply));
  } catch (err) {
    if (abort.signal.aborted) {
      if (!res.writableEnded && !res.destroyed) return apiError(res, 504, 'Alice took too long to answer', 'api_error');
      return;
    }
    console.error('[voice] error:', err?.message || err);
    const status = err instanceof LLMUnavailableError ? 503 : 500;
    return apiError(res, status, err instanceof LLMUnavailableError ? 'Alice\'s language model is not reachable' : 'Alice hit an error', 'api_error');
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
}
