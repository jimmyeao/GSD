/**
 * HomeAssistantAgent — sends smart-home commands ("turn off the kitchen light",
 * "set the heating to 21") to Home Assistant's own Assist conversation API.
 *
 * Why forward rather than let the LLM pick services itself: Home Assistant
 * already knows which entities you exposed to Assist and runs the matching
 * and the action, so Alice never needs a device list, can only touch what you
 * exposed, and cannot invent a service call. Alice's job here is routing,
 * confirmation and speech.
 *
 * Config (alice-backend/.env — the token is a secret, never log or print it):
 *   HA_URL           default http://homeassistant.local:8123
 *   HA_TOKEN         long-lived access token (HA profile → Security). Required.
 *   HA_ASSIST_AGENT  default conversation.home_assistant (HA's built-in matcher)
 *   HA_LANGUAGE      default en
 *
 * Commands touching locks, alarms, garage doors etc. need a spoken/typed "yes"
 * first. The pending command rides in the conversation history (the bot's
 * confirmation prompt), so nothing is stored server-side.
 */

import { stmts } from '../db.js';

const HA_TIMEOUT_MS = 15_000;
const CONFIRM_PREFIX = 'Please confirm: "';
const CONFIRM_RE = /^Please confirm: "(.+?)"\. Say yes/s;

export const NOT_CONFIGURED_REPLY = "Home Assistant isn't connected to Alice yet. Add an access token as HA_TOKEN in Alice's settings.";

const SENSITIVE = /\b(unlock|lock|alarm|disarm|arm|garage|shutters?|siren|front door|back door|security)\b/i;
const YES = /^\s*(yes|yeah|yep|yup|confirm(ed)?|go ahead|do it|please do|ok(ay)?|sure)\b/i;
const NO = /^\s*(no|nope|cancel|don'?t|stop|never ?mind)\b/i;

export class HomeAssistantError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export function haConfig(env = process.env) {
  const token = (env.HA_TOKEN || '').trim();
  if (!token) return null;
  return {
    url: (env.HA_URL || 'http://homeassistant.local:8123').trim().replace(/\/+$/, ''),
    token,
    agentId: (env.HA_ASSIST_AGENT || 'conversation.home_assistant').trim(),
    language: (env.HA_LANGUAGE || 'en').trim(),
  };
}

export const needsConfirmation = (text) => SENSITIVE.test(text);
export const isConfirmation = (text) => YES.test(text);
export const isCancellation = (text) => NO.test(text);

/** The command awaiting "yes", if the last assistant message asked for one. */
export function findPendingCommand(history = []) {
  const last = [...history].reverse().find(m => m?.role === 'assistant');
  const m = last && typeof last.content === 'string' ? last.content.match(CONFIRM_RE) : null;
  return m ? m[1] : null;
}

// HA reads "in the house" as an area called "house" and answers "Not any".
const WHOLE_HOME = /\s+(?:(?:in|throughout|around|across|at)\s+(?:the|my|our)\s+(?:(?:whole|entire)\s+)?(?:house|home|place|flat|apartment)|at\s+home|everywhere(?:\s+in\s+the\s+(?:house|home))?)(?=\s*[?.!]*\s*$)/i;

/** Drop trailing whole-home phrases so HA matches on the device/domain alone. */
export function stripWholeHome(text) {
  const out = text.replace(WHOLE_HOME, '').trim();
  return out || text;
}

const confirmPrompt = (command) => `${CONFIRM_PREFIX}${command}". Say yes to go ahead, or no to cancel.`;

/** POST one utterance to Assist. Returns { text, type }. Never logs the text or token. */
export async function askAssist(text, cfg, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  let res;
  try {
    res = await doFetch(`${cfg.url}/api/conversation/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: cfg.language, agent_id: cfg.agentId }),
      signal: AbortSignal.any([AbortSignal.timeout(HA_TIMEOUT_MS), ...(deps.signal ? [deps.signal] : [])]),
    });
  } catch (err) {
    if (deps.signal?.aborted) throw err;
    throw new HomeAssistantError('unreachable', `could not reach Home Assistant (${err.name})`);
  }
  if (res.status === 401 || res.status === 403) throw new HomeAssistantError('auth', 'Home Assistant rejected the access token');
  if (res.status === 404) throw new HomeAssistantError('agent', 'Home Assistant does not know that Assist agent');
  if (!res.ok) throw new HomeAssistantError('http', `Home Assistant returned ${res.status}`);

  const data = await res.json().catch(() => ({}));
  const type = data?.response?.response_type ?? 'error';
  const speech = String(data?.response?.speech?.plain?.speech ?? '').trim();
  if (speech) return { text: speech, type };
  return { text: type === 'action_done' ? 'Done.' : "Home Assistant didn't have an answer for that.", type };
}

const FRIENDLY = {
  unreachable: "I couldn't reach Home Assistant just now.",
  auth: "Home Assistant didn't accept Alice's access token. It may have been revoked.",
  agent: "Home Assistant doesn't recognise the configured Assist agent.",
  http: 'Home Assistant ran into a problem with that.',
};

/**
 * Core: one user turn → one spoken reply. Pure of Socket.IO so the web agent
 * and the voice endpoint can share it. Never throws for HA/network failures.
 */
export async function handleHomeCommand({ content, history = [], signal }, deps = {}) {
  const cfg = deps.config === undefined ? haConfig() : deps.config;
  if (!cfg) return { text: NOT_CONFIGURED_REPLY, ok: false };

  let command = stripWholeHome(content.trim());
  const pending = findPendingCommand(history);
  if (pending) {
    if (isConfirmation(command)) command = pending;          // run exactly what was confirmed
    else if (isCancellation(command)) return { text: "Okay, I've cancelled that.", ok: true };
    else if (needsConfirmation(command)) return { text: confirmPrompt(command), ok: true };
  } else if (needsConfirmation(command)) {
    return { text: confirmPrompt(command), ok: true };
  }

  try {
    const { text, type } = await askAssist(command, cfg, { ...deps, signal });
    return { text, ok: type !== 'error' };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { text: FRIENDLY[err.kind] ?? FRIENDLY.http, ok: false };
  }
}

/** Socket.IO agent: same event contract as runWebAgent (thinking → token(s) → done). */
export async function runHomeAssistantAgent({ socket, content, history = [], convId }, deps = {}) {
  const abort = new AbortController();
  const onStop = () => abort.abort();
  socket.once('stop:stream', onStop);
  try {
    socket.emit('thinking', {});
    const { text } = await handleHomeCommand({ content, history, signal: abort.signal }, deps);
    for (let i = 0; i < text.length; i += 8) socket.emit('token', { token: text.slice(i, i + 8) });
    if (text && convId) {
      try {
        stmts.insertMessage.run(convId, 'assistant', 'HomeAssistantAgent', text);
        stmts.touchConversation.run(convId);
      } catch { /* ignore */ }
    }
    socket.emit('done', { agent: 'HomeAssistantAgent' });
  } catch (err) {
    if (abort.signal.aborted) { socket.emit('done', { agent: 'HomeAssistantAgent' }); return; }
    console.error('[HomeAssistantAgent] error:', err?.message || err);
    socket.emit('error', { message: 'HomeAssistantAgent error' });
  } finally {
    socket.off('stop:stream', onStop);
  }
}
