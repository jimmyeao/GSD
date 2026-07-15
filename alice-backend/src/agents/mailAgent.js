/**
 * MailAgent — LLM-driven email + calendar assistant with tool calls and
 * explicit user approval for mutating actions.
 *
 * Exposed in two places:
 *   - runMailAgent()      → main per-message loop, dispatched from server.js
 *   - executeApproval()   → resolves a pending approval row (approve or reject)
 *   - MAIL_TOOLS, MUTATING_TOOLS → shared with the LLM tool-calling plumbing
 *
 * Design notes:
 *   - Read-only tools execute immediately and feed back into the loop as
 *     role:'tool' messages so the model can continue its reasoning.
 *   - Mutating tools are NEVER executed inside the loop; they are parked as
 *     an approval row and delivered to the UI via a `mail:approval_needed`
 *     socket event. Resolution happens in server.js.
 *   - The loop is capped at MAX_ITERATIONS to prevent a wedged model from
 *     burning tokens indefinitely.
 */

import { config } from '../config.js';
import { stmts } from '../db.js';
import { completeWithTools, complete, LLMUnavailableError } from './llmClient.js';
import { withAccount, getProviderAdapter } from '../mail/client.js';
import { runUnsubscribe, chooseStrategy } from '../mail/unsubscribe.js';

const MAX_ITERATIONS = 6;
const MAX_PENDING_PER_USER = 20;

// ── Tool catalogue (OpenAI function-call format) ───────────────────────

export const MAIL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_mail_accounts',
      description: 'List the email accounts the user has connected (id, provider, email, status).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_messages',
      description: 'List or search messages. Use folder="all" when searching for something the user may have received anywhere (junk, clutter, archive) — it searches the whole mailbox.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer', description: 'Account to query. Call list_mail_accounts first if unsure.' },
          folder: {
            type: 'string',
            enum: ['inbox', 'sent', 'drafts', 'trash', 'junk', 'spam', 'archive', 'clutter', 'all'],
            default: 'inbox',
            description: 'inbox | sent | drafts | trash | junk (MS) | spam (Gmail) | archive | clutter (MS legacy) | all (whole mailbox)',
          },
          limit: { type: 'integer', default: 15, maximum: 50 },
          query: { type: 'string', description: 'Optional free-text search (sender, subject, body).' },
        },
        required: ['account_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_message',
      description: 'Fetch a single message including body and attachments metadata.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          message_id: { type: 'string' },
        },
        required: ['account_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_events',
      description: 'List calendar events between two ISO 8601 timestamps. Focus-time blocks are filtered out by default; set include_focus_time=true if the user explicitly asks to see them.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          from: { type: 'string', description: 'ISO 8601 start of range.' },
          to: { type: 'string', description: 'ISO 8601 end of range.' },
          include_focus_time: { type: 'boolean', description: 'Include "Focus time" blocks in the results. Default false.' },
        },
        required: ['account_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event',
      description: 'Fetch a single calendar event.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          event_id: { type: 'string' },
        },
        required: ['account_id', 'event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Propose sending a new email. Requires user approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string', description: 'HTML or plain-text message body.' },
          body_type: { type: 'string', enum: ['html', 'text'], default: 'html' },
        },
        required: ['account_id', 'to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_to_message',
      description: 'Propose a reply to an existing message. Requires user approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          message_id: { type: 'string' },
          body: { type: 'string' },
          reply_all: { type: 'boolean', default: false },
          body_type: { type: 'string', enum: ['html', 'text'], default: 'html' },
        },
        required: ['account_id', 'message_id', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trash_message',
      description: 'Propose moving a message to the trash. Requires user approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          message_id: { type: 'string' },
        },
        required: ['account_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_message',
      description: 'Propose moving a message to a different folder/label. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          message_id: { type: 'string' },
          folder: { type: 'string', enum: ['inbox', 'sent', 'drafts', 'trash'] },
        },
        required: ['account_id', 'message_id', 'folder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Propose creating a calendar event. Requires user approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          subject: { type: 'string' },
          start: { type: 'string', description: 'ISO 8601 start datetime.' },
          end: { type: 'string', description: 'ISO 8601 end datetime.' },
          attendees: { type: 'array', items: { type: 'string' } },
          location: { type: 'string' },
          body: { type: 'string', description: 'Event description / agenda.' },
          timezone: { type: 'string', default: 'UTC' },
        },
        required: ['account_id', 'subject', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_event',
      description: 'Propose updating an existing calendar event. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          event_id: { type: 'string' },
          subject: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' } },
          location: { type: 'string' },
          body: { type: 'string' },
          timezone: { type: 'string' },
        },
        required: ['account_id', 'event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_event',
      description: 'Propose deleting a calendar event. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          event_id: { type: 'string' },
        },
        required: ['account_id', 'event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unsubscribe_message',
      description: "Unsubscribe from a mailing list using the email's List-Unsubscribe header. Use when the user asks to unsubscribe, stop receiving, or get off a mailing list. Always call list_messages or get_message first to get a real message ID.",
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'integer' },
          message_id: { type: 'string' },
        },
        required: ['account_id', 'message_id'],
      },
    },
  },
];

// Batch dispatcher — model hands us a manifest of items to act on, we fan
// out one approval card per item. This avoids the "emit N parallel tool
// calls" failure mode where the model only proposes one at a time.
MAIL_TOOLS.push({
  type: 'function',
  function: {
    name: 'plan_mutations',
    description: 'Queue a BATCH of mutation proposals (one approval card per item) in a single call. ALWAYS use this instead of individual mutation tools when the user asks to act on multiple items ("unsubscribe from all X", "trash every Y", "reply to each Z"). Each entry in `actions` becomes its own approval card that the user approves/rejects independently.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          description: 'Array of mutation proposals. One approval card is created per item.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['send_message','reply_to_message','trash_message','move_message','unsubscribe_message','create_event','update_event','delete_event'],
              },
              account_id: { type: 'integer' },
              message_id: { type: 'string', description: 'Required for reply/trash/move/unsubscribe.' },
              event_id: { type: 'string', description: 'Required for update_event/delete_event.' },
              folder: { type: 'string', enum: ['inbox','sent','drafts','trash'], description: 'For move_message.' },
              to: { type: 'array', items: { type: 'string' }, description: 'For send_message.' },
              cc: { type: 'array', items: { type: 'string' } },
              bcc: { type: 'array', items: { type: 'string' } },
              subject: { type: 'string' },
              body: { type: 'string' },
              body_type: { type: 'string', enum: ['html','text'] },
              reply_all: { type: 'boolean' },
              start: { type: 'string' },
              end: { type: 'string' },
              attendees: { type: 'array', items: { type: 'string' } },
              location: { type: 'string' },
              timezone: { type: 'string' },
            },
            required: ['action', 'account_id'],
          },
        },
      },
      required: ['actions'],
    },
  },
});

export const MUTATING_TOOLS = new Set([
  'send_message',
  'reply_to_message',
  'trash_message',
  'move_message',
  'create_event',
  'update_event',
  'delete_event',
  'unsubscribe_message',
]);

// ── System prompt ──────────────────────────────────────────────────────

function buildSystemPrompt({ strategy = null, accountsHint = null } = {}) {
  const now = new Date();
  // e.g. "Sunday, 19 April 2026, 13:45 UTC"
  const nowStr = now.toUTCString();
  const isoDate = now.toISOString().slice(0, 10);

  const strategyBlock = strategy
    ? `\n\nTURN STRATEGY (derived from this user message by a planner — follow unless it contradicts the rules above): ${strategy}`
    : '';
  const accountsBlock = accountsHint
    ? `\n\nCONNECTED ACCOUNTS (use these exact IDs — do not invent): ${accountsHint}`
    : '';

  return `You are MailAgent, the user's email and calendar assistant.

CURRENT TIME: ${nowStr} (ISO date: ${isoDate}). All relative time references ("today", "tomorrow", "next week", "this month") MUST be resolved against THIS timestamp, not any date in your training data. When calling list_events or create_event, compute 'from'/'to'/'start'/'end' from this current time.

CONNECTED ACCOUNTS: call list_mail_accounts at the start of every conversation if you don't already know them. Never ask the user to find their account ID — look it up.

MULTI-ACCOUNT QUERIES: If the user says "both", "all accounts", "all inboxes", doesn't specify an account, or asks a general question (e.g. "do I have any events next week?"), automatically query EVERY active account — make one tool call per account, then merge and present the results grouped by account. Do NOT ask the user to pick one. Only ask if there's ambiguity about which account to SEND from or TAKE an action on.

SEARCH STRATEGY: When the user asks to find emails from a sender, subject, or keyword (e.g. "find Waitrose emails", "where's the invoice from British Gas"), call list_messages with folder="all" and query set to the search term. This searches junk, clutter, archive, and every other folder — don't ask the user where to look. Only scope to a specific folder if the user explicitly names one ("in my inbox", "in drafts"). If the first search returns nothing, report it — don't keep guessing folders.

IMPORTANT: when you call a tool with an account_id, VERIFY you used the correct ID for the account the user asked about. The ID comes from list_mail_accounts. Don't swap Google's ID for Microsoft's or vice versa. Label results with the account email in the output so the user can see which account each result came from.

READ actions (list_messages, get_message, list_events, get_event, list_mail_accounts) run automatically when you call them — you'll receive the result and then continue.

WRITE actions (send_message, reply_to_message, trash_message, move_message, create_event, update_event, delete_event, unsubscribe_message) require explicit user approval. The approval card IS the confirmation — NEVER ask the user "would you like me to..." or "shall I proceed?" in chat before calling a write tool. Just call it. The card gives the user Approve/Reject buttons; that is their confirmation point.

If the user has explicitly asked for an action ("unsubscribe me from X", "delete that email", "reply yes to Bob"), call the tool immediately. If they say "yes", "confirmed", "do it", "go ahead", "proceed" after you've shown them results, call the tool on the relevant item immediately — do not ask again.

BATCH ACTIONS (use plan_mutations — it is the ONLY reliable way): For any request that targets multiple items ("unsubscribe from all X", "trash every Y", "reply to each Z", "ask me to confirm each one", or any "them" referring to a search result), call plan_mutations ONCE with an "actions" array containing every item. The server fans out one approval card per entry — the user approves/rejects each individually. Do NOT call the per-item mutation tools N times for batch asks; that path is unreliable at batch size. Single per-item tools (trash_message, unsubscribe_message, …) are only for when the user has targeted exactly ONE specific item.

SEMANTICS: Calling a mutation tool (or plan_mutations) does NOT execute the action — it only creates approval card(s). The user's click is the real confirmation. So it is SAFE to include many entries in plan_mutations — being "cautious" by batching one item at a time is actively wrong here.

CONCRETE EXAMPLE: If the user says "unsubscribe from all marketing emails" and list_messages returned 4 marketing candidates with IDs A, B, C, D, your next assistant response should contain ONE tool call:
  plan_mutations({ actions: [
    { action: "unsubscribe_message", account_id: 1, message_id: "A" },
    { action: "unsubscribe_message", account_id: 1, message_id: "B" },
    { action: "unsubscribe_message", account_id: 2, message_id: "C" },
    { action: "unsubscribe_message", account_id: 2, message_id: "D" },
  ] })
That produces 4 approval cards in one go.

COMPOUND ASKS (chained actions like "unsubscribe AND trash" or "trash THEN archive"): emit ALL the first-action tool calls in this turn. After the user resolves those approvals, you will be automatically re-invoked with a continuation hint in the conversation — then emit the second-action tool calls on the SAME items. Never emit the second action in the first turn; the message IDs haven't been "touched" yet and the provider may behave unexpectedly.

ACCOUNT DISCIPLINE: every message_id and event_id belongs to exactly ONE account. When you found a message via list_messages on account X, you MUST pass account_id=X to any follow-up tool that uses that message_id (get_message, unsubscribe_message, trash_message, reply_to_message, move_message). Never pass a different account_id with an ID from another account — the provider will reject it and mislead you into thinking the account needs reconnecting. Double-check the account_id matches the account the message was returned from.

Style: concise, professional, no fluff. When summarising mail or events, use bullet lists. Group by account when presenting multi-account results. Dates in the user's local format. Never reveal raw tokens, IDs, or internal error traces.

If a tool fails (account needs reconnect, API error), explain briefly and suggest a next step. Don't retry automatically more than once.${accountsBlock}${strategyBlock}`;
}

/**
 * Ask a fast small model to produce a concise strategy line describing the
 * most efficient tool-call sequence for the user's request. The strategy is
 * injected into MailAgent's system prompt for this turn so the big model has
 * clearer marching orders and doesn't waste tool calls figuring it out.
 *
 * Returns null on failure or for trivial prompts — MailAgent then runs without
 * a strategy hint, as before.
 */
// Multi-step signals that justify the planner's latency cost.
// Single-intent queries ("check for marketing emails", "any events tomorrow?")
// skip planning and go straight to the main agent.
const PLANNER_TRIGGERS = /\b(all|every|each|both|accounts?|and then|then\s+(?:trash|reply|delete|move|send|unsubscribe)|unsubscribe.*(?:trash|delete)|trash.*(?:reply|unsubscribe)|multiple|batch)\b/i;

// Compound = the user chained two or more mutating actions in one message.
// Used by the server to decide whether to auto-continue MailAgent after the
// first batch of approvals resolves (e.g. "unsubscribe then trash").
const COMPOUND_VERBS = /(unsubscribe|trash|delete|move|reply|archive|forward|send)/i;
export function isCompoundRequest(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  // Explicit chaining connectives.
  if (/\b(then|after\s+that|after\s+which|and\s+then)\b/.test(s) && COMPOUND_VERBS.test(s)) return true;
  // Two distinct action verbs joined by "and" / "," — e.g. "unsubscribe … and trash …"
  const verbs = (s.match(/\b(unsubscribe|trash|delete|move|reply|archive|forward|send)\b/gi) || [])
    .map(v => v.toLowerCase());
  const unique = new Set(verbs);
  return unique.size >= 2;
}

async function planStrategy(userContent, accounts) {
  const text = String(userContent || '').trim();
  if (text.length < 40) return null;
  // Only engage the planner for genuinely multi-step / batch requests.
  // Count action verbs too — two or more in one message usually means a compound ask.
  const actionVerbMatches = text.match(/\b(unsubscribe|trash|delete|reply|send|move|archive|create|schedule|forward)\b/gi) || [];
  const looksMultiStep = PLANNER_TRIGGERS.test(text) || actionVerbMatches.length >= 2;
  if (!looksMultiStep) return null;

  const gen = config.models.general;
  if (!gen?.endpoint || !gen?.model) return null;

  const accountsList = (accounts || [])
    .filter(a => a.status === 'active')
    .map(a => `${a.provider}:${a.email} (id=${a.id})`)
    .join(', ') || '(none)';

  const systemMsg = `You plan tool-calling strategies for an email assistant.
Given a user request, produce ONE concise strategy paragraph (under 80 words) describing the most efficient tool-call sequence. Always start with "Strategy:". No JSON, no bullet lists, no greeting.

Available tools:
- READ (auto-exec): list_mail_accounts, list_messages(account_id, folder?, query?), get_message, list_events, get_event
- BATCH DISPATCH (creates one approval card per item): plan_mutations({ actions: [...] })
- Per-item mutations (use only for one specific targeted item): send_message, reply_to_message, trash_message, move_message, create_event, update_event, delete_event, unsubscribe_message

Rules:
- When searching for mail, prefer folder="all" and a concrete query string.
- Prefer parallel tool calls across accounts over serial ones.
- For ANY multi-item request (all/each/every, "them", "confirm each"), instruct: "use plan_mutations with an actions array — one entry per matching item. Do NOT call per-item tools N times."
- For compound asks (unsubscribe AND trash), instruct: "emit plan_mutations with all unsubscribe entries this turn; after those approvals resolve, the agent will be re-invoked and can emit plan_mutations with the trash entries on the same message_ids."
- If the request is trivial (greeting, single short fact), output: "Strategy: answer directly, no tools needed."
- Reference real account IDs from the list; never invent IDs.

Connected accounts: ${accountsList}`;

  try {
    // Reasoning models (Qwen3.6, etc.) burn a few hundred tokens and several
    // seconds thinking before ever emitting the actual strategy line — 6s/160
    // tokens was tuned for Ollama's qwen3:32b and is nowhere near enough here.
    // Still a graceful no-op on failure (see catch below), so it's safe to
    // give this a generous budget rather than have it fail silently every time.
    const raw = await complete(gen.endpoint, gen.model, [
      { role: 'system', content: systemMsg },
      { role: 'user', content: text },
    ], { signal: AbortSignal.timeout(20_000), numPredict: 1024 });
    const s = String(raw || '').trim();
    if (s.length < 10) return null;
    // Normalise — keep one line only, strip leading "Strategy:" if duplicated later.
    return s.replace(/\s+/g, ' ').slice(0, 800);
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function ownsAccount(accountId, userId) {
  if (!Number.isFinite(accountId)) return null;
  return stmts.getMailAccount.get(accountId, userId) || null;
}

async function previewForAction(action, payload, ctx = {}) {
  try {
    switch (action) {
      case 'send_message': {
        const to = Array.isArray(payload.to) ? payload.to.join(', ') : String(payload.to || '');
        return { text: `Send email to ${to} — "${payload.subject || '(no subject)'}"`, extras: null };
      }
      case 'reply_to_message':
        return { text: `${payload.reply_all ? 'Reply-all' : 'Reply'} to message ${payload.message_id}`, extras: null };
      case 'trash_message':
        return { text: `Move message ${payload.message_id} to trash`, extras: null };
      case 'move_message':
        return { text: `Move message ${payload.message_id} to ${payload.folder}`, extras: null };
      case 'create_event':
        return { text: `Create event "${payload.subject}" ${payload.start} → ${payload.end}`, extras: null };
      case 'update_event':
        return { text: `Update event ${payload.event_id}`, extras: null };
      case 'delete_event':
        return { text: `Delete event ${payload.event_id}`, extras: null };
      case 'unsubscribe_message': {
        // Best-effort synchronous lookup to enrich the approval card. Fall
        // back to a generic preview if the fetch fails — the executor does
        // the same work again and will surface its own errors later.
        const user = ctx.user;
        const accountId = Number(payload.account_id);
        const messageId = String(payload.message_id || '');
        if (!user || !accountId || !messageId) {
          return { text: `Unsubscribe from message ${messageId || '(unknown)'}`, extras: null };
        }
        try {
          const msg = await withAccount(accountId, user.id, async (provider, accessToken) => {
            const adapter = getProviderAdapter(provider);
            return adapter.getMessage(accessToken, messageId);
          });
          const strat = chooseStrategy(msg);
          const senderName = msg?.from?.name || msg?.from?.email || 'sender';
          const senderEmail = msg?.from?.email || null;
          let target_domain = null;
          if (strat.method === 'one_click' || strat.method === 'web_link') {
            try { target_domain = new URL(strat.target).hostname; } catch { /* ignore */ }
          }
          const text =
            strat.method === 'none'
              ? `Unsubscribe from "${msg?.subject || '(no subject)'}" — no method available`
              : `Unsubscribe from "${msg?.subject || '(no subject)'}" (${strat.method.replace('_', '-')})`;
          const extras = {
            sender: { name: senderName, email: senderEmail },
            subject: msg?.subject || '',
            strategy: {
              method: strat.method,
              target: strat.target,
              target_domain,
              source: strat.source || 'header',
            },
          };
          return { text, extras };
        } catch {
          return { text: `Unsubscribe from message ${messageId}`, extras: null };
        }
      }
      default:
        return { text: action, extras: null };
    }
  } catch {
    return { text: action, extras: null };
  }
}

// Both Gmail (hex, usually 16 chars) and MS Graph (base64-ish, usually 100+
// chars) message IDs are at least 16 chars of [A-Za-z0-9_\-=]. This catches
// obvious hallucinations like "msg-waitrose-recipes" or "12345".
function looksLikeRealMessageId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (s.length < 16) return false;
  if (!/^[A-Za-z0-9_\-=.+/]+$/.test(s)) return false;
  // Reject anything that contains a real English word pattern — msg-*, fake-*, etc.
  if (/^(msg|test|fake|example|placeholder|sample|demo)[-_]/i.test(s)) return false;
  return true;
}

function validateMutation(action, args) {
  // Returns { ok: true, payload } or { ok: false, error }
  const require = (name) => {
    if (args[name] == null || args[name] === '') {
      return `missing required field: ${name}`;
    }
    return null;
  };

  switch (action) {
    case 'send_message': {
      for (const f of ['account_id', 'to', 'subject', 'body']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      if (!Array.isArray(args.to)) args.to = [String(args.to)];
      if (args.cc != null && !Array.isArray(args.cc)) args.cc = [String(args.cc)];
      if (args.bcc != null && !Array.isArray(args.bcc)) args.bcc = [String(args.bcc)];
      return { ok: true, payload: args };
    }
    case 'reply_to_message': {
      for (const f of ['account_id', 'message_id', 'body']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      if (!looksLikeRealMessageId(args.message_id)) {
        return { ok: false, error: 'message_id does not look valid — use an exact ID from list_messages, do not invent one' };
      }
      return { ok: true, payload: args };
    }
    case 'trash_message': {
      for (const f of ['account_id', 'message_id']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      if (!looksLikeRealMessageId(args.message_id)) {
        return { ok: false, error: 'message_id does not look valid — use an exact ID from list_messages, do not invent one' };
      }
      return { ok: true, payload: args };
    }
    case 'move_message': {
      for (const f of ['account_id', 'message_id', 'folder']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      const folders = new Set(['inbox', 'sent', 'drafts', 'trash']);
      if (!folders.has(args.folder)) return { ok: false, error: 'invalid folder' };
      if (!looksLikeRealMessageId(args.message_id)) {
        return { ok: false, error: 'message_id does not look valid — use an exact ID from list_messages, do not invent one' };
      }
      return { ok: true, payload: args };
    }
    case 'create_event': {
      for (const f of ['account_id', 'subject', 'start', 'end']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      return { ok: true, payload: args };
    }
    case 'update_event': {
      for (const f of ['account_id', 'event_id']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      return { ok: true, payload: args };
    }
    case 'delete_event': {
      for (const f of ['account_id', 'event_id']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      return { ok: true, payload: args };
    }
    case 'unsubscribe_message': {
      for (const f of ['account_id', 'message_id']) {
        const e = require(f); if (e) return { ok: false, error: e };
      }
      if (!Number.isFinite(Number(args.account_id))) return { ok: false, error: 'account_id must be a number' };
      args.message_id = String(args.message_id);
      if (!looksLikeRealMessageId(args.message_id)) {
        return { ok: false, error: 'message_id does not look valid — use an exact ID from list_messages, do not invent one' };
      }
      return { ok: true, payload: args };
    }
    default:
      return { ok: false, error: 'unknown mutating tool' };
  }
}

// Stream a string out as tokens in small chunks to match the rest of the UI.
async function streamText(socket, text, chunkSize = 4) {
  for (let i = 0; i < text.length; i += chunkSize) {
    socket.emit('token', { token: text.slice(i, i + chunkSize) });
  }
}

// Redact token-safe log context — never log recipient lists or bodies.
function logActionSafely(tag, action, accountId) {
  try {
    console.log(`[MailAgent] ${tag} action=${action} account=${accountId}`);
  } catch { /* ignore */ }
}

// ── Read-only tool execution ───────────────────────────────────────────

async function runReadTool(user, name, args) {
  const accountId = Number(args.account_id);
  if (name !== 'list_mail_accounts' && !ownsAccount(accountId, user.id)) {
    throw Object.assign(new Error('Account not found or not owned by user'), { code: 'NOT_OWNER' });
  }

  switch (name) {
    case 'list_mail_accounts': {
      const rows = stmts.listMailAccounts.all(user.id);
      return rows.map(r => ({
        id: r.id,
        provider: r.provider,
        email: r.email,
        display_name: r.display_name,
        status: r.status,
      }));
    }
    case 'list_messages': {
      const folder = args.folder || 'inbox';
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const q = args.query || '';
      const full = await withAccount(accountId, user.id, async (provider, accessToken) => {
        const adapter = getProviderAdapter(provider);
        return adapter.listMessages(accessToken, { folder, limit, q });
      });
      // Compact the result before handing it to the model — the agent only
      // needs id/from/subject/snippet/date to decide which emails match and
      // emit tool calls. Stripping the rest keeps iter-N prompt-eval under
      // control on large-context models like qwen3:32b.
      return (Array.isArray(full) ? full : []).map(m => ({
        id: m.id,
        from: m.from?.email || m.from?.name || '',
        subject: m.subject || '',
        snippet: (m.snippet || '').slice(0, 120),
        date: m.date || null,
      }));
    }
    case 'get_message': {
      if (!args.message_id) throw new Error('message_id required');
      return withAccount(accountId, user.id, async (provider, accessToken) => {
        const adapter = getProviderAdapter(provider);
        return adapter.getMessage(accessToken, String(args.message_id));
      });
    }
    case 'list_events': {
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const from = args.from || now.toISOString();
      const to = args.to || weekFromNow.toISOString();
      const events = await withAccount(accountId, user.id, async (provider, accessToken) => {
        const adapter = getProviderAdapter(provider);
        return adapter.listEvents(accessToken, { from, to });
      });
      // Filter focus-time events unless the user explicitly asked for them.
      const includeFocus = args.include_focus_time === true;
      return includeFocus ? events : events.filter(e => !e.is_focus_time);
    }
    case 'get_event': {
      if (!args.event_id) throw new Error('event_id required');
      return withAccount(accountId, user.id, async (provider, accessToken) => {
        const adapter = getProviderAdapter(provider);
        return adapter.getEvent(accessToken, String(args.event_id));
      });
    }
    default:
      throw new Error(`unknown read tool: ${name}`);
  }
}

// ── Approval execution (resolved via socket.on('mail:approval_response')) ─

/**
 * Execute a previously-approved mutating action. Caller has already verified
 * ownership and status. Returns { ok, result, error }.
 */
export async function executeApprovedAction(user, approval) {
  const payload = JSON.parse(approval.payload);
  const accountId = Number(approval.account_id);
  const account = stmts.getMailAccount.get(accountId, user.id);
  if (!account) return { ok: false, error: 'account not found' };

  try {
    logActionSafely('executing', approval.action_type, accountId);
    const result = await withAccount(accountId, user.id, async (provider, accessToken) => {
      const adapter = getProviderAdapter(provider);
      switch (approval.action_type) {
        case 'send_message':
          return adapter.sendMessage(accessToken, {
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            subject: payload.subject,
            body: payload.body,
            bodyType: payload.body_type || 'html',
          });
        case 'reply_to_message':
          return adapter.replyMessage(accessToken, payload.message_id, {
            body: payload.body,
            replyAll: !!payload.reply_all,
            bodyType: payload.body_type || 'html',
          });
        case 'trash_message':
          return adapter.trashMessage(accessToken, payload.message_id);
        case 'move_message':
          return adapter.moveMessage(accessToken, payload.message_id, { folder: payload.folder });
        case 'create_event':
          return adapter.createEvent(accessToken, {
            subject: payload.subject,
            start: payload.start,
            end: payload.end,
            attendees: payload.attendees,
            location: payload.location,
            body: payload.body,
            timezone: payload.timezone || 'UTC',
          });
        case 'update_event':
          return adapter.updateEvent(accessToken, payload.event_id, payload);
        case 'delete_event':
          return adapter.deleteEvent(accessToken, payload.event_id);
        case 'unsubscribe_message': {
          const message = await adapter.getMessage(accessToken, String(payload.message_id));
          const outcome = await runUnsubscribe({
            message,
            provider: adapter,
            account,
            accessToken,
          });
          // Safe structured log — no URLs, no addresses.
          try {
            console.log(JSON.stringify({
              tag: 'mail.unsubscribe',
              method: outcome.method,
              account_id: accountId,
              message_id: payload.message_id,
              status: outcome.result === 'failed' ? 'failed' : 'done',
            }));
          } catch { /* ignore */ }
          return outcome;
        }
        default:
          throw new Error(`unsupported action: ${approval.action_type}`);
      }
    });
    // Unsubscribe never throws; treat a 'failed' outcome as ok:false so the
    // caller surfaces the details via the existing error path.
    if (approval.action_type === 'unsubscribe_message') {
      if (result && result.result === 'failed') {
        return { ok: false, error: result.details || 'unsubscribe failed', method: result.method };
      }
      return { ok: true, result };
    }
    return { ok: true, result };
  } catch (err) {
    logActionSafely('failed', approval.action_type, accountId);
    return { ok: false, error: err?.message || 'action failed' };
  }
}

export function summariseExecution(approval, result) {
  const payload = (() => {
    try { return JSON.parse(approval.payload); } catch { return {}; }
  })();
  switch (approval.action_type) {
    case 'send_message': {
      const to = Array.isArray(payload.to) ? payload.to.join(', ') : String(payload.to || '');
      return `Sent email to ${to} — "${payload.subject || '(no subject)'}".`;
    }
    case 'reply_to_message':
      return `Reply sent${payload.reply_all ? ' (reply-all)' : ''}.`;
    case 'trash_message':
      return `Message moved to trash.`;
    case 'move_message':
      return `Message moved to ${payload.folder}.`;
    case 'create_event':
      return `Event created: "${payload.subject}" ${payload.start} → ${payload.end}.`;
    case 'update_event':
      return `Event updated.`;
    case 'delete_event':
      return `Event deleted.`;
    case 'unsubscribe_message': {
      const sender = payload?.sender?.email || payload?.sender?.name || 'this list';
      const method = result?.method;
      const outcome = result?.result;
      if (outcome === 'failed') {
        return `Unsubscribe attempt failed: ${result?.details || 'unknown error'}.`;
      }
      if (method === 'one_click') {
        return `Unsubscribed from ${sender} (one-click POST, server accepted).`;
      }
      if (method === 'mailto') {
        const addr = payload?.strategy?.target || sender;
        return `Sent unsubscribe request to ${addr} — allow up to 48 hours for the list to process it.`;
      }
      if (method === 'web_link') {
        if (outcome === 'done') {
          return `Unsubscribed from ${sender} via web link — ${result?.details || 'server accepted the request'}.`;
        }
        if (outcome === 'manual') {
          return result?.details || `The unsubscribe page needs a confirmation click. Open: ${payload?.strategy?.target || ''}`;
        }
        return `Web-link unsubscribe failed: ${result?.details || 'unknown error'}.`;
      }
      if (method === 'none') {
        return `That email doesn't have a standard unsubscribe header. You'll need to find the unsubscribe link in the body manually.`;
      }
      return result?.details || 'Unsubscribe completed.';
    }
    default:
      return 'Action completed.';
  }
}

// ── Main agent runner ──────────────────────────────────────────────────

export async function runMailAgent({ socket, user, content, history = [], convId, continuation = null }) {
  // Routing guard — need at least one active account
  const accounts = stmts.listMailAccounts.all(user.id);
  const hasActive = accounts.some(a => a.status === 'active');
  if (!hasActive) {
    const msg = `You don't have any email accounts connected. Click **Mail** in the header and connect a Gmail or Microsoft account.`;
    await streamText(socket, msg);
    if (convId) {
      try {
        const { stmts: s } = await import('../db.js');
        s.insertMessage.run(convId, 'assistant', 'MailAgent', msg);
        s.touchConversation.run(convId);
      } catch { /* ignore */ }
    }
    socket.emit('done', { agent: 'MailAgent' });
    return;
  }

  const modelCfg = config.models.mail || config.models.general;

  // Run a fast planner first so the big model gets a concrete strategy.
  // Skip for continuations — the original turn already produced a plan and
  // the history carries it forward.
  const accountsHint = accounts
    .filter(a => a.status === 'active')
    .map(a => `${a.provider}:${a.email} (id=${a.id})`)
    .join(', ');
  const strategy = continuation ? null : await planStrategy(content, accounts);

  const continuationHint = continuation
    ? `\n\n== CONTINUATION (automatic re-invocation) ==\n${continuation}`
    : '';

  const messages = [
    { role: 'system', content: buildSystemPrompt({ strategy, accountsHint }) + continuationHint },
    ...history.slice(-10).filter(h => h?.role && h?.content).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content },
  ];

  const abort = new AbortController();
  const onStop = () => abort.abort();
  socket.once('stop:stream', onStop);

  let fullNarration = '';
  let exitDueToApproval = false;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let resp;
      const iterStart = Date.now();
      // completeWithTools is a single non-streaming call — reasoning models
      // can take 30-90+ seconds with zero output in between, which looks
      // identical to "stopped" from the UI. Show the same "thinking"
      // indicator the main chat stream uses; appendToken() hides it
      // automatically the moment real output (narration or content) arrives.
      socket.emit('thinking', {});
      try {
        resp = await completeWithTools(modelCfg.endpoint, modelCfg.model, messages, {
          signal: abort.signal,
          tools: MAIL_TOOLS,
          temperature: 0.3,
          // Batch actions (10+ unsubscribes in one turn) need room for many
          // tool-call JSON blocks; 2048 was clipping them to a single call.
          numPredict: 6144,
          // qwen3:32b's default num_ctx gets requested as 262144 and clamped
          // to the training context 40960 — which means a 5.3 GiB KV cache
          // and attention compute over 40k positions per token. Force 16384
          // explicitly; still comfortably larger than any real mail tool
          // loop (compacted list_messages × 2 accounts ≈ 2k tokens).
          numCtx: 16384,
        });
      } catch (err) {
        if (err instanceof LLMUnavailableError) {
          const m = `The language model backend is not reachable right now. Please try again shortly.`;
          await streamText(socket, m);
          fullNarration += m;
          break;
        }
        throw err;
      }

      const toolCalls = resp.tool_calls;
      try {
        console.log(`[MailAgent] iter=${iter} tool_calls=${toolCalls?.length ?? 0}`
          + (toolCalls?.length ? ` names=${toolCalls.map(t => t.function?.name).join(',')}` : '')
          + (resp.finish_reason ? ` finish=${resp.finish_reason}` : '')
          + ` elapsed=${Date.now() - iterStart}ms`
          + ` msgs=${messages.length}`
          + ` model=${modelCfg.model}`);
      } catch { /* ignore */ }
      if (!toolCalls || toolCalls.length === 0) {
        // Final answer — stream content
        const text = resp.content || '';
        await streamText(socket, text);
        fullNarration += text;
        break;
      }

      // Append the assistant turn so the model can see its own tool invocations.
      // vLLM's OpenAI-compat server validates this against the standard OpenAI
      // schema, which requires `function.arguments` to be a JSON-encoded
      // STRING (pydantic rejects an object here with a "string_type" error) —
      // the opposite of Ollama's native API, which wanted an object.
      messages.push({
        role: 'assistant',
        content: resp.content || '',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
          },
        })),
      });

      // Flush any assistant narration that came alongside the tool call.
      if (resp.content) {
        await streamText(socket, resp.content);
        fullNarration += resp.content;
      }

      // Partition tool calls:
      //   - plan_mutations: dispatcher — fans out one approval per item below.
      //   - read calls: run concurrently (I/O bound).
      //   - single-item mutations: stay sequential (each touches DB + socket).
      const planCalls = toolCalls.filter(tc => tc.function.name === 'plan_mutations');
      const readCalls = toolCalls.filter(tc => tc.function.name !== 'plan_mutations' && !MUTATING_TOOLS.has(tc.function.name));
      const mutationCalls = toolCalls.filter(tc => MUTATING_TOOLS.has(tc.function.name));

      // Emit "Looking up..." narrations up front so the user sees progress
      // immediately, then await all reads in parallel.
      for (const tc of readCalls) {
        const narr = `\n> Looking up ${tc.function.name.replace(/_/g, ' ')}…\n`;
        socket.emit('token', { token: narr });
        fullNarration += narr;
      }
      const readResults = await Promise.allSettled(
        readCalls.map(tc => runReadTool(user, tc.function.name, tc.function.arguments || {})),
      );
      // Push results in the same order as the original tool_calls so the
      // model can correlate tool_call_id correctly.
      for (let i = 0; i < readCalls.length; i++) {
        const tc = readCalls[i];
        const r = readResults[i];
        if (r.status === 'fulfilled') {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(r.value).slice(0, 32_000),
          });
        } else {
          const err = r.reason;
          const errBody = {
            error: err?.code === 'NEEDS_RECONNECT' ? 'needs_reconnect' : (err?.message || 'tool_failed'),
          };
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(errBody) });
        }
      }

      // Expand plan_mutations into per-item synthetic mutation tool calls so
      // the loop below treats them uniformly. One tool result gets attached
      // to the plan_mutations call itself summarising what was queued.
      for (const planCall of planCalls) {
        const planArgs = planCall.function.arguments || {};
        const items = Array.isArray(planArgs.actions) ? planArgs.actions : [];
        const summary = [];
        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx] || {};
          const action = item.action;
          if (!action || !MUTATING_TOOLS.has(action)) {
            summary.push({ index: idx, status: 'skipped', reason: `unsupported action: ${action}` });
            continue;
          }
          const { action: _a, ...rest } = item;
          mutationCalls.push({
            id: `${planCall.id}_${idx}`,
            type: 'function',
            function: { name: action, arguments: rest },
          });
          summary.push({ index: idx, status: 'queued', action });
        }
        messages.push({
          role: 'tool',
          tool_call_id: planCall.id,
          content: JSON.stringify({ queued: summary.length, items: summary }),
        });
      }

      for (const tc of mutationCalls) {
        const name = tc.function.name;
        const args = tc.function.arguments || {};

        // Validate, gate, and park as an approval row. Do NOT execute.
        const pending = stmts.countPendingApprovalsByUser.get(user.id)?.count ?? 0;
        if (pending >= MAX_PENDING_PER_USER) {
          const m = `\n\n> You already have ${pending} pending approvals. Resolve some before requesting another action.`;
          await streamText(socket, m);
          fullNarration += m;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: 'rate_limited' }),
          });
          continue;
        }

        const accountId = Number(args.account_id);
        const account = ownsAccount(accountId, user.id);
        if (!account) {
          const errMsg = 'Account not found or not owned by user.';
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
          continue;
        }

        const v = validateMutation(name, args);
        if (!v.ok) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: v.error }) });
          continue;
        }

        const previewed = await previewForAction(name, v.payload, { user });
        const preview = previewed.text;
        const enrichedPayload = previewed.extras
          ? { ...v.payload, ...previewed.extras }
          : v.payload;
        const payloadJson = JSON.stringify(enrichedPayload);
        const info = stmts.insertApproval.run(
          user.id,
          accountId,
          convId || null,
          name,
          payloadJson,
          preview,
        );
        const approvalId = info.lastInsertRowid;

        logActionSafely('approval_needed', name, accountId);
        socket.emit('mail:approval_needed', {
          approvalId,
          action: name,
          payload: enrichedPayload,
          preview,
          conversationId: convId || null,
        });

        const blurb = `\n\nI'd like to **${preview}**. Approve or reject this action in the card above.\n`;
        await streamText(socket, blurb);
        fullNarration += blurb;

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ approvalId, status: 'pending', preview }),
        });

        exitDueToApproval = true;
      }

      if (exitDueToApproval) break;

      if (iter === MAX_ITERATIONS - 1) {
        const m = `\n\n> Tool loop exceeded. Stopping to prevent runaway.`;
        await streamText(socket, m);
        fullNarration += m;
      }
    }

    if (fullNarration && convId) {
      try {
        stmts.insertMessage.run(convId, 'assistant', 'MailAgent', fullNarration);
        stmts.touchConversation.run(convId);
      } catch { /* ignore */ }
    }
    socket.emit('done', { agent: 'MailAgent' });
  } catch (err) {
    if (abort.signal.aborted) {
      if (fullNarration && convId) {
        try {
          stmts.insertMessage.run(convId, 'assistant', 'MailAgent', fullNarration);
          stmts.touchConversation.run(convId);
        } catch { /* ignore */ }
      }
      socket.emit('done', { agent: 'MailAgent' });
      return;
    }
    console.error('[MailAgent] error:', err?.message || err);
    socket.emit('error', { message: `MailAgent error: ${err?.message || 'unknown'}` });
  } finally {
    socket.off('stop:stream', onStop);
  }
}
