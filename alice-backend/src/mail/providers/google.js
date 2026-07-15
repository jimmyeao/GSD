/**
 * Gmail + Google Calendar adapter.
 * On 401 we throw TokenExpiredError so the caller can refresh and retry once.
 */

import { extractListUnsubscribe } from '../unsubscribe.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const CAL = 'https://www.googleapis.com/calendar/v3';

export class TokenExpiredError extends Error {
  constructor(message = 'Access token expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

const LABEL_MAP = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  spam: 'SPAM',
  // 'all' is handled specially — no label filter, searches whole mailbox.
  // Gmail has no 'clutter' concept (Google calls it 'Categories'); map to inbox.
  clutter: 'INBOX',
  archive: null, // archive in Gmail = not in any category label; omit label filter
};

async function gFetch(accessToken, url, init = {}) {
  // No timeout here meant a stalled/rate-limited Google API call would hang
  // the whole MailAgent tool loop indefinitely with zero feedback to the
  // user — the loop's own read-tool call sites have no timeout of their own.
  const timeoutSignal = AbortSignal.timeout(30_000);
  const combined = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const resp = await fetch(url, {
    ...init,
    signal: combined,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  if (resp.status === 401) throw new TokenExpiredError();
  if (!resp.ok) {
    let details = '';
    try {
      const data = await resp.json();
      if (data?.error?.message) details = ` — ${data.error.message}`;
    } catch { /* ignore */ }
    throw new Error(`Google API ${resp.status}${details}`);
  }
  return resp.json();
}

/** Run async tasks with a concurrency cap. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function parseAddress(raw) {
  if (!raw) return { name: null, email: null };
  // Matches "Name <email@host>" or plain "email@host"
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    return { name: (m[1] || '').trim() || null, email: m[2].trim() };
  }
  const trimmed = raw.trim();
  return { name: null, email: trimmed };
}

function parseAddressList(raw) {
  if (!raw) return [];
  // Split on commas that are not inside quotes
  const parts = [];
  let buf = '';
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ',' && !inQuote) {
      if (buf.trim()) parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(parseAddress).filter(p => p.email);
}

function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) {
    if (h?.name) out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

function hasAttachment(payload) {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) return true;
  if (Array.isArray(payload.parts)) {
    return payload.parts.some(hasAttachment);
  }
  return false;
}

function decodeB64Url(s) {
  if (!s) return '';
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function collectBodies(payload, acc = { html: '', text: '' }) {
  if (!payload) return acc;
  const mt = (payload.mimeType || '').toLowerCase();
  if (mt === 'text/html' && payload.body?.data && !acc.html) {
    acc.html = decodeB64Url(payload.body.data);
  } else if (mt === 'text/plain' && payload.body?.data && !acc.text) {
    acc.text = decodeB64Url(payload.body.data);
  }
  for (const p of payload.parts || []) {
    collectBodies(p, acc);
  }
  return acc;
}

function collectAttachments(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    acc.push({
      id: payload.body.attachmentId,
      name: payload.filename,
      size: payload.body.size || 0,
      contentType: payload.mimeType || 'application/octet-stream',
    });
  }
  for (const p of payload.parts || []) collectAttachments(p, acc);
  return acc;
}

export async function listMessages(accessToken, { limit = 25, folder = 'inbox', q = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const params = new URLSearchParams();
  params.set('maxResults', String(safeLimit));
  // 'all' or 'archive' → no label filter (whole mailbox). Others use the map.
  if (folder !== 'all') {
    const label = LABEL_MAP[folder];
    if (label) params.set('labelIds', label);
  }
  if (q && String(q).trim()) params.set('q', String(q));

  const list = await gFetch(accessToken, `${GMAIL}/users/me/messages?${params.toString()}`);
  const ids = (list.messages || []).map(m => m.id);
  if (ids.length === 0) return [];

  const metaParams = new URLSearchParams({ format: 'metadata' });
  for (const h of ['From', 'To', 'Subject', 'Date']) metaParams.append('metadataHeaders', h);
  const metaQs = metaParams.toString();

  const messages = await mapWithConcurrency(ids, 10, async (id) => {
    const m = await gFetch(accessToken, `${GMAIL}/users/me/messages/${encodeURIComponent(id)}?${metaQs}`);
    const h = headerMap(m.payload);
    return {
      id: m.id,
      threadId: m.threadId || null,
      from: parseAddress(h.from),
      to: parseAddressList(h.to),
      subject: h.subject || '',
      snippet: m.snippet || '',
      date: h.date || null,
      unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
      hasAttachments: hasAttachment(m.payload),
    };
  });
  return messages;
}

export async function getMessage(accessToken, messageId) {
  const m = await gFetch(
    accessToken,
    `${GMAIL}/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );
  const h = headerMap(m.payload);
  const bodies = collectBodies(m.payload);
  const attachments = collectAttachments(m.payload);
  const listUnsubscribe = extractListUnsubscribe(h);

  return {
    id: m.id,
    threadId: m.threadId || null,
    from: parseAddress(h.from),
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    bcc: parseAddressList(h.bcc),
    subject: h.subject || '',
    date: h.date || null,
    body_html: bodies.html || '',
    body_text: bodies.text || '',
    attachments,
    headers: h,
    listUnsubscribe,
  };
}

function mapEvent(e) {
  return {
    id: e.id,
    subject: e.summary || '',
    start: e.start ? { dateTime: e.start.dateTime || e.start.date || null, timeZone: e.start.timeZone || 'UTC' } : null,
    end: e.end ? { dateTime: e.end.dateTime || e.end.date || null, timeZone: e.end.timeZone || 'UTC' } : null,
    location: e.location || null,
    organizer: e.organizer ? { name: e.organizer.displayName || null, email: e.organizer.email || null } : null,
    attendees: (e.attendees || []).map(a => ({
      name: a.displayName || null,
      email: a.email || null,
      response: a.responseStatus || null,
    })),
    body_preview: e.description ? String(e.description).slice(0, 500) : '',
    is_all_day: !!(e.start && e.start.date && !e.start.dateTime),
    is_focus_time: e.eventType === 'focusTime',
    event_type: e.eventType || 'default',
  };
}

export async function listEvents(accessToken, { from, to } = {}) {
  if (!from || !to) throw new Error('from and to are required (ISO 8601)');
  const params = new URLSearchParams({
    timeMin: from,
    timeMax: to,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const data = await gFetch(
    accessToken,
    `${CAL}/calendars/primary/events?${params.toString()}`,
  );
  return (data.items || []).map(mapEvent);
}

export async function getEvent(accessToken, eventId) {
  const e = await gFetch(
    accessToken,
    `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
  return mapEvent(e);
}

// ── Mutating operations (Phase 3 — only called after user approval) ────

/**
 * Like gFetch but tolerant of empty bodies (DELETE returns 204).
 */
async function gMutate(accessToken, url, { method = 'POST', headers = {}, body = null } = {}) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body != null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 401) throw new TokenExpiredError();
  if (!resp.ok) {
    let details = '';
    try {
      const data = await resp.json();
      if (data?.error?.message) details = ` — ${data.error.message}`;
    } catch { /* ignore */ }
    throw new Error(`Google API ${resp.status}${details}`);
  }
  if (resp.status === 204) return {};
  try { return await resp.json(); } catch { return {}; }
}

function toEmailList(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .map(v => (typeof v === 'string' ? v.trim() : v?.email?.trim()))
    .filter(Boolean);
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Build a simple RFC 822 message. For HTML bodies we quoted-printable-escape
 * nothing — Gmail accepts UTF-8 bodies as-is with Content-Transfer-Encoding: 8bit.
 * Callers should keep bodies reasonably sized; no attachment support yet.
 */
function buildMime({ to, cc, bcc, subject, body, bodyType = 'html', inReplyTo, references, fromName } = {}) {
  const lines = [];
  lines.push('MIME-Version: 1.0');
  const toList = toEmailList(to);
  if (toList.length) lines.push(`To: ${toList.join(', ')}`);
  const ccList = toEmailList(cc);
  if (ccList.length) lines.push(`Cc: ${ccList.join(', ')}`);
  const bccList = toEmailList(bcc);
  if (bccList.length) lines.push(`Bcc: ${bccList.join(', ')}`);
  if (subject) lines.push(`Subject: ${subject.replace(/[\r\n]+/g, ' ')}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  if (fromName) lines.push(`From: ${fromName}`);
  const ct = bodyType === 'text' ? 'text/plain' : 'text/html';
  lines.push(`Content-Type: ${ct}; charset=utf-8`);
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(String(body || ''));
  return lines.join('\r\n');
}

export async function sendMessage(accessToken, { to, cc, bcc, subject, body, bodyType = 'html' } = {}) {
  if (!to || (Array.isArray(to) && to.length === 0)) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  if (!body) throw new Error('body required');

  const mime = buildMime({ to, cc, bcc, subject, body, bodyType });
  const raw = base64UrlEncode(mime);

  const sent = await gMutate(
    accessToken,
    `${GMAIL}/users/me/messages/send`,
    { method: 'POST', body: { raw } },
  );
  return { id: sent?.id || null };
}

export async function replyMessage(accessToken, messageId, { body, replyAll = false, bodyType = 'html' } = {}) {
  if (!messageId) throw new Error('messageId required');
  if (!body) throw new Error('body required');

  // Fetch the original to find threadId, subject, and message-id / references headers
  const orig = await gFetch(
    accessToken,
    `${GMAIL}/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
  );
  const h = headerMap(orig.payload);
  let subject = h.subject || '';
  if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;

  const fromAddr = parseAddress(h.from);
  const toList = replyAll
    ? [fromAddr, ...parseAddressList(h.to), ...parseAddressList(h.cc)]
        .filter(p => p?.email)
        .map(p => p.email)
    : [fromAddr?.email].filter(Boolean);

  const msgIdHeader = h['message-id'];
  const references = [h.references, msgIdHeader].filter(Boolean).join(' ');

  const mime = buildMime({
    to: toList,
    subject,
    body,
    bodyType,
    inReplyTo: msgIdHeader || undefined,
    references: references || undefined,
  });
  const raw = base64UrlEncode(mime);

  const sent = await gMutate(
    accessToken,
    `${GMAIL}/users/me/messages/send`,
    { method: 'POST', body: { raw, threadId: orig.threadId } },
  );
  return { id: sent?.id || null };
}

export async function trashMessage(accessToken, messageId) {
  if (!messageId) throw new Error('messageId required');
  await gMutate(
    accessToken,
    `${GMAIL}/users/me/messages/${encodeURIComponent(messageId)}/trash`,
    { method: 'POST' },
  );
  return { ok: true };
}

export async function moveMessage(accessToken, messageId, { folder, fromFolder } = {}) {
  if (!messageId) throw new Error('messageId required');
  const addLabel = folder ? (LABEL_MAP[folder] || folder) : null;
  const removeLabel = fromFolder ? (LABEL_MAP[fromFolder] || fromFolder) : 'INBOX';
  const body = {};
  if (addLabel && addLabel !== 'TRASH') body.addLabelIds = [addLabel];
  // Moving to trash means using trash endpoint; a "move" that just leaves the
  // inbox is represented by removeLabelIds: ['INBOX'].
  if (folder === 'trash') {
    // Prefer the trash endpoint for correctness
    return trashMessage(accessToken, messageId);
  }
  body.removeLabelIds = [removeLabel];
  await gMutate(
    accessToken,
    `${GMAIL}/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    { method: 'POST', body },
  );
  return { ok: true };
}

function toCalendarAttendees(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .map(v => (typeof v === 'string' ? { email: v } : v))
    .filter(a => a && a.email)
    .map(a => ({ email: a.email, displayName: a.name || undefined }));
}

function buildCalEventBody(data = {}, timezone = 'UTC') {
  const out = {};
  if (data.subject != null) out.summary = String(data.subject);
  if (data.body != null) out.description = String(data.body);
  if (data.location != null) out.location = String(data.location);
  if (data.start) {
    const s = typeof data.start === 'string' ? { dateTime: data.start } : data.start;
    out.start = { dateTime: s.dateTime || s.date_time, timeZone: s.timeZone || s.time_zone || timezone };
  }
  if (data.end) {
    const e = typeof data.end === 'string' ? { dateTime: data.end } : data.end;
    out.end = { dateTime: e.dateTime || e.date_time, timeZone: e.timeZone || e.time_zone || timezone };
  }
  if (data.attendees) out.attendees = toCalendarAttendees(data.attendees);
  return out;
}

export async function createEvent(accessToken, { subject, start, end, attendees, location, body, timezone = 'UTC' } = {}) {
  if (!subject) throw new Error('subject required');
  if (!start || !end) throw new Error('start and end required');
  const payload = buildCalEventBody({ subject, start, end, attendees, location, body }, timezone);
  const data = await gMutate(
    accessToken,
    `${CAL}/calendars/primary/events`,
    { method: 'POST', body: payload },
  );
  return { id: data?.id || null };
}

export async function updateEvent(accessToken, eventId, updates = {}) {
  if (!eventId) throw new Error('eventId required');
  const payload = buildCalEventBody(updates, updates.timezone || 'UTC');
  await gMutate(
    accessToken,
    `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: payload },
  );
  return { ok: true };
}

export async function deleteEvent(accessToken, eventId) {
  if (!eventId) throw new Error('eventId required');
  await gMutate(
    accessToken,
    `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  );
  return { ok: true };
}
