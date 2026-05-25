/**
 * Microsoft Graph v1.0 adapter for mail + calendar.
 *
 * On 401 from the API we throw TokenExpiredError so the caller can refresh
 * and retry exactly once.
 */

import { extractListUnsubscribe } from '../unsubscribe.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export class TokenExpiredError extends Error {
  constructor(message = 'Access token expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

const FOLDER_MAP = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  trash: 'deleteditems',
  junk: 'junkemail',
  archive: 'archive',
  clutter: 'clutter',
  // 'all' is handled specially in listMessages — searches the whole mailbox.
};

function mapRecipient(r) {
  const email = r?.emailAddress?.address || null;
  const name = r?.emailAddress?.name || null;
  if (!email) return null;
  return { name, email };
}

function mapRecipients(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(mapRecipient).filter(Boolean);
}

async function graphFetch(accessToken, path, { headers = {}, ...init } = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...headers,
    },
  });
  if (resp.status === 401) throw new TokenExpiredError();
  if (!resp.ok) {
    let details = '';
    try {
      const data = await resp.json();
      if (data?.error?.message) details = ` — ${data.error.message}`;
    } catch { /* ignore */ }
    throw new Error(`Microsoft Graph ${resp.status}${details}`);
  }
  return resp.json();
}

function mapListMessage(m) {
  return {
    id: m.id,
    threadId: m.conversationId || null,
    from: mapRecipient(m.from) || { name: null, email: null },
    to: mapRecipients(m.toRecipients),
    subject: m.subject || '',
    snippet: m.bodyPreview || '',
    date: m.receivedDateTime || null,
    unread: m.isRead === false,
    hasAttachments: !!m.hasAttachments,
  };
}

export async function listMessages(accessToken, { limit = 25, folder = 'inbox', q = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const params = new URLSearchParams();
  params.set('$top', String(safeLimit));
  params.set('$select',
    'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,hasAttachments');

  const hasSearch = q && String(q).trim().length > 0;
  const headers = {};
  if (hasSearch) {
    // Graph $search requires ConsistencyLevel: eventual and forbids $orderby.
    params.set('$search', `"${String(q).replace(/"/g, '\\"')}"`);
    headers.ConsistencyLevel = 'eventual';
  } else {
    params.set('$orderby', 'receivedDateTime desc');
  }

  // 'all' searches the whole mailbox (every folder). Useful when the user
  // doesn't know which folder a message is in (Outlook's Junk/Clutter/Archive
  // auto-routing makes single-folder searches miss things).
  const path = folder === 'all'
    ? `/me/messages?${params.toString()}`
    : `/me/mailFolders/${encodeURIComponent(FOLDER_MAP[folder] || 'inbox')}/messages?${params.toString()}`;

  const data = await graphFetch(accessToken, path, { headers });
  const values = Array.isArray(data.value) ? data.value : [];
  return values.map(mapListMessage);
}

export async function getMessage(accessToken, messageId) {
  const params = new URLSearchParams({
    $select: 'id,conversationId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,body,hasAttachments,internetMessageHeaders',
  });
  const msg = await graphFetch(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}?${params.toString()}`,
  );

  // Attachments are on a separate endpoint; fetch in parallel.
  let attachments = [];
  if (msg.hasAttachments) {
    try {
      const att = await graphFetch(
        accessToken,
        `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,size,contentType`,
      );
      attachments = (att.value || []).map(a => ({
        id: a.id,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
      }));
    } catch {
      attachments = [];
    }
  }

  const bodyHtml = msg.body?.contentType === 'html' ? msg.body?.content || '' : '';
  const bodyText = msg.body?.contentType === 'text' ? msg.body?.content || '' : '';

  const headers = {};
  for (const h of msg.internetMessageHeaders || []) {
    if (h?.name) headers[h.name] = h.value;
  }

  const listUnsubscribe = extractListUnsubscribe(headers);

  return {
    id: msg.id,
    threadId: msg.conversationId || null,
    from: mapRecipient(msg.from) || { name: null, email: null },
    to: mapRecipients(msg.toRecipients),
    cc: mapRecipients(msg.ccRecipients),
    bcc: mapRecipients(msg.bccRecipients),
    subject: msg.subject || '',
    date: msg.receivedDateTime || null,
    body_html: bodyHtml,
    body_text: bodyText,
    attachments,
    headers,
    listUnsubscribe,
  };
}

function mapEvent(e) {
  return {
    id: e.id,
    subject: e.subject || '',
    start: e.start?.dateTime ? { dateTime: e.start.dateTime, timeZone: e.start.timeZone || 'UTC' } : null,
    end: e.end?.dateTime ? { dateTime: e.end.dateTime, timeZone: e.end.timeZone || 'UTC' } : null,
    location: e.location?.displayName || null,
    organizer: e.organizer?.emailAddress
      ? { name: e.organizer.emailAddress.name || null, email: e.organizer.emailAddress.address || null }
      : null,
    attendees: (e.attendees || []).map(a => ({
      name: a.emailAddress?.name || null,
      email: a.emailAddress?.address || null,
      response: a.status?.response || null,
    })),
    body_preview: e.bodyPreview || '',
    is_all_day: !!e.isAllDay,
    // MS doesn't have an eventType === focusTime equivalent; detect via
    // category or subject heuristic. Outlook's auto-created focus blocks are
    // typed 'focusTime' or categorised "Focus Time" depending on the tenant.
    is_focus_time: detectFocusTime(e),
    event_type: e.type || 'singleInstance',
  };
}

function detectFocusTime(e) {
  const subj = (e.subject || '').toLowerCase();
  if (/^focus\s*(time|block)?\b/.test(subj)) return true;
  const cats = Array.isArray(e.categories) ? e.categories : [];
  return cats.some(c => /focus[\s-]*time/i.test(c));
}

export async function listEvents(accessToken, { from, to } = {}) {
  if (!from || !to) throw new Error('from and to are required (ISO 8601)');
  const params = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $orderby: 'start/dateTime',
    $top: '100',
  });
  const data = await graphFetch(
    accessToken,
    `/me/calendarView?${params.toString()}`,
  );
  const values = Array.isArray(data.value) ? data.value : [];
  return values.map(mapEvent);
}

export async function getEvent(accessToken, eventId) {
  const data = await graphFetch(
    accessToken,
    `/me/events/${encodeURIComponent(eventId)}`,
  );
  return mapEvent(data);
}

// ── Mutating operations (Phase 3 — only called after user approval) ────

/**
 * Graph fetch variant that tolerates 202/204 and does not require JSON.
 * Used by the mutation helpers where the body is often empty.
 */
async function graphMutate(accessToken, path, { method = 'POST', headers = {}, body = null } = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body != null) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 401) throw new TokenExpiredError();
  if (!resp.ok) {
    let details = '';
    try {
      const data = await resp.json();
      if (data?.error?.message) details = ` — ${data.error.message}`;
    } catch { /* ignore */ }
    throw new Error(`Microsoft Graph ${resp.status}${details}`);
  }
  // 202/204 → no body
  if (resp.status === 202 || resp.status === 204) return {};
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

function toGraphRecipients(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .map(v => (typeof v === 'string' ? v.trim() : v?.email?.trim()))
    .filter(Boolean)
    .map(email => ({ emailAddress: { address: email } }));
}

export async function sendMessage(accessToken, { to, cc, bcc, subject, body, bodyType = 'html' } = {}) {
  if (!to || (Array.isArray(to) && to.length === 0)) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  if (!body) throw new Error('body required');

  const message = {
    subject: String(subject),
    body: { contentType: bodyType === 'text' ? 'Text' : 'HTML', content: String(body) },
    toRecipients: toGraphRecipients(to),
  };
  if (cc) message.ccRecipients = toGraphRecipients(cc);
  if (bcc) message.bccRecipients = toGraphRecipients(bcc);

  await graphMutate(accessToken, '/me/sendMail', {
    method: 'POST',
    body: { message, saveToSentItems: true },
  });
  // Graph's sendMail doesn't return an id; caller can find it in Sent if needed.
  return { id: null };
}

export async function replyMessage(accessToken, messageId, { body, replyAll = false, bodyType = 'html' } = {}) {
  if (!messageId) throw new Error('messageId required');
  if (!body) throw new Error('body required');
  const path = `/me/messages/${encodeURIComponent(messageId)}/${replyAll ? 'replyAll' : 'reply'}`;
  await graphMutate(accessToken, path, {
    method: 'POST',
    body: {
      message: {
        body: { contentType: bodyType === 'text' ? 'Text' : 'HTML', content: String(body) },
      },
    },
  });
  return { id: null };
}

export async function trashMessage(accessToken, messageId) {
  if (!messageId) throw new Error('messageId required');
  await graphMutate(accessToken, `/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST',
    body: { destinationId: 'deleteditems' },
  });
  return { ok: true };
}

export async function moveMessage(accessToken, messageId, { folder } = {}) {
  if (!messageId) throw new Error('messageId required');
  const dest = FOLDER_MAP[folder] || folder;
  if (!dest) throw new Error('folder required');
  const data = await graphMutate(accessToken, `/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST',
    body: { destinationId: dest },
  });
  return { ok: true, newId: data?.id || null };
}

function toGraphAttendees(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .map(v => (typeof v === 'string' ? { email: v } : v))
    .filter(a => a && a.email)
    .map(a => ({
      emailAddress: { address: a.email, name: a.name || undefined },
      type: a.type || 'required',
    }));
}

function buildGraphEventBody(data = {}, timezone = 'UTC') {
  const out = {};
  if (data.subject != null) out.subject = String(data.subject);
  if (data.start) {
    const s = typeof data.start === 'string' ? { dateTime: data.start, timeZone: timezone } : data.start;
    out.start = { dateTime: s.dateTime || s.date_time, timeZone: s.timeZone || s.time_zone || timezone };
  }
  if (data.end) {
    const e = typeof data.end === 'string' ? { dateTime: data.end, timeZone: timezone } : data.end;
    out.end = { dateTime: e.dateTime || e.date_time, timeZone: e.timeZone || e.time_zone || timezone };
  }
  if (data.attendees) out.attendees = toGraphAttendees(data.attendees);
  if (data.location) out.location = { displayName: String(data.location) };
  if (data.body) {
    out.body = { contentType: data.bodyType === 'text' ? 'Text' : 'HTML', content: String(data.body) };
  }
  return out;
}

export async function createEvent(accessToken, { subject, start, end, attendees, location, body, timezone = 'UTC' } = {}) {
  if (!subject) throw new Error('subject required');
  if (!start || !end) throw new Error('start and end required');
  const payload = buildGraphEventBody({ subject, start, end, attendees, location, body }, timezone);
  const data = await graphMutate(accessToken, '/me/events', { method: 'POST', body: payload });
  return { id: data?.id || null };
}

export async function updateEvent(accessToken, eventId, updates = {}) {
  if (!eventId) throw new Error('eventId required');
  const payload = buildGraphEventBody(updates, updates.timezone || 'UTC');
  await graphMutate(accessToken, `/me/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: payload,
  });
  return { ok: true };
}

export async function deleteEvent(accessToken, eventId) {
  if (!eventId) throw new Error('eventId required');
  await graphMutate(accessToken, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  return { ok: true };
}
