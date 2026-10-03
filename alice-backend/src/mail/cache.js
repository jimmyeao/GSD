/**
 * Cache-aside store for mail contacts/threads so MailAgent doesn't have to
 * re-fetch the same person/thread live on every turn. Pure cache — no LLM
 * calls here. Freshness is computed lazily at read time (no expires_at
 * column/sweeper); see /home/jimmy/.claude/plans/sleepy-painting-gem.md.
 */

import { stmts } from '../db.js';

export const CONTACT_TTL_MS = 15 * 60_000;
export const THREAD_TTL_MS = 5 * 60_000;

function tokenize(s) {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

/** True if `candidate` (a name or email) shares any word with `queryTokens` — matches "priya" mentioned alone against display_name "Priya Sharma". */
function matchesTokens(queryTokens, candidate) {
  const candTokens = tokenize(candidate);
  return candTokens.some((t) => queryTokens.includes(t));
}

function isFresh(refreshedAt, ttlMs) {
  if (!refreshedAt) return false;
  // sqlite's datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS' with no
  // timezone marker. Date.parse() treats that ambiguous format as LOCAL
  // time, which silently breaks freshness checks on any non-UTC server —
  // normalize to an explicit UTC ISO string before parsing.
  const iso = refreshedAt.includes('T') ? refreshedAt : `${refreshedAt.replace(' ', 'T')}Z`;
  const age = Date.now() - Date.parse(iso);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

/** Returns the cached contact row only if still within TTL, else null. */
export function getFreshContact(accountId, email, ttlMs = CONTACT_TTL_MS) {
  const row = stmts.getMailContact.get(accountId, email);
  return row && isFresh(row.refreshed_at, ttlMs) ? row : null;
}

export function upsertContact(accountId, { email, displayName, lastMessageId, lastMessageDate, lastSubject, messageCount }) {
  stmts.upsertMailContact.run(accountId, email, displayName ?? null, lastMessageId ?? null, lastMessageDate ?? null, lastSubject ?? null, messageCount ?? 0);
}

/** Returns the cached thread row only if still within TTL, else null. */
export function getFreshThread(accountId, threadId, ttlMs = THREAD_TTL_MS) {
  const row = stmts.getMailThread.get(accountId, threadId);
  return row && isFresh(row.refreshed_at, ttlMs) ? row : null;
}

export function upsertThread(accountId, { threadId, subject, participants, messageSummaries, lastMessageDate }) {
  stmts.upsertMailThread.run(
    accountId,
    threadId,
    subject ?? null,
    participants ? JSON.stringify(participants) : null,
    messageSummaries ? JSON.stringify(messageSummaries) : null,
    lastMessageDate ?? null,
  );
}

/**
 * Wipes all cached contact/thread rows for one account after a mutation, so
 * the next lookup is forced live rather than serving stale derived state.
 * Whole-account rather than a surgical single-row delete: mutation payloads
 * (message_id, event_id, etc.) don't carry a thread_id, so there's no reliable
 * way to target just the affected row — over-invalidating a few extra rows is
 * cheap and safe, silently serving a stale one is not.
 */
export function invalidateMailCache(accountId) {
  stmts.deleteMailContactsByAccount.run(accountId);
  stmts.deleteMailThreadsByAccount.run(accountId);
}

/**
 * Fresh (within TTL) cached threads for one account whose participants or
 * subject match `query` — used to serve list_messages from cache instead of
 * a live provider call.
 */
export function getFreshThreadsMatching(accountId, query, ttlMs = THREAD_TTL_MS) {
  if (!query) return [];
  const queryTokens = tokenize(query);
  const rows = stmts.listMailThreadsByAccount.all(accountId);
  const fresh = rows.filter((r) => isFresh(r.refreshed_at, ttlMs));
  return fresh
    .filter((r) => {
      const subjectMatch = r.subject && matchesTokens(queryTokens, r.subject);
      let participantMatch = false;
      try {
        const participants = r.participants ? JSON.parse(r.participants) : [];
        participantMatch = participants.some(
          (p) => (p.email && matchesTokens(queryTokens, p.email)) || (p.name && matchesTokens(queryTokens, p.name))
        );
      } catch { /* malformed cache row — treat as no match */ }
      return subjectMatch || participantMatch;
    })
    .map((r) => {
      let summaries = [];
      try { summaries = r.message_summaries ? JSON.parse(r.message_summaries) : []; } catch { /* ignore */ }
      return summaries;
    })
    .flat();
}

/**
 * Cached facts about a contact, across every account_id the user owns — a
 * contact seen on a second connected mailbox must not disappear from context
 * just because only one account was checked.
 */
export function getContactContext(accountIds, text) {
  if (!text || !Array.isArray(accountIds) || !accountIds.length) return '';
  const queryTokens = tokenize(text);
  const hits = [];
  for (const accountId of accountIds) {
    const contacts = stmts.listMailContactsByAccount.all(accountId);
    for (const c of contacts) {
      const nameMatch = c.display_name && matchesTokens(queryTokens, c.display_name);
      const emailMatch = matchesTokens(queryTokens, c.email);
      if (nameMatch || emailMatch) hits.push(c);
    }
  }
  if (!hits.length) return '';
  const lines = hits.map((c) => `- ${c.display_name || c.email} <${c.email}>: last message "${c.last_subject || '(no subject)'}" on ${c.last_message_date || 'unknown date'}`);
  return [
    'The following are cached notes about mail contacts the user has mentioned before (may be up to 15 minutes stale):',
    ...lines,
  ].join('\n');
}
