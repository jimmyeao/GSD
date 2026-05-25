/**
 * MailAgent approval card — renders in the chat stream for actions that need
 * user consent before the backend executes them.
 *
 * Lifecycle:
 *   mail:approval_needed   → renderApprovalCard(...)
 *   user clicks Approve/Reject → onApprove / onReject callback (emits socket event)
 *   mail:approval_resolved → setResolvedState(card, status, error?)
 *   mail:approval_error    → setErrorState(card, message) if targeted at this card
 *
 * XSS safety:
 *   - All untrusted payload strings are written via textContent.
 *   - HTML email bodies are stripped to text-only before rendering in a <pre>.
 *   - No innerHTML is used with payload data.
 */

// ── Action labels + icons ────────────────────────────────────────────────
const ACTION_META = {
  send_message:        { icon: '✉',  title: 'Send email' },
  reply_to_message:    { icon: '↩',  title: 'Reply to message' },
  trash_message:       { icon: '🗑', title: 'Trash message' },
  move_message:        { icon: '📥', title: 'Move message' },
  create_event:        { icon: '📅', title: 'Create calendar event' },
  update_event:        { icon: '✏',  title: 'Update calendar event' },
  delete_event:        { icon: '🗑', title: 'Delete calendar event' },
  unsubscribe_message: { icon: '🚫', title: 'Unsubscribe from mailing list' },
};

const BODY_COLLAPSED_MAX = 320; // chars of body to show when collapsed

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Render a new approval card and append it to `container`.
 *
 * @param {HTMLElement} container — chat messages container
 * @param {object} data — { approvalId, action, payload, preview }
 * @param {object} handlers — { onApprove(), onReject() }
 * @returns {HTMLElement} — the card element (so callers can store it in a Map)
 */
export function renderApprovalCard(container, data, handlers) {
  const { approvalId, action, payload = {}, preview = '' } = data || {};
  const meta = ACTION_META[action] || { icon: '❓', title: `Unknown action: ${action}` };

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = String(approvalId);
  card.dataset.action = String(action);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'approval-card__header';

  const icon = document.createElement('span');
  icon.className = 'approval-card__icon';
  icon.textContent = meta.icon;
  header.appendChild(icon);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'approval-card__title-wrap';

  const title = document.createElement('span');
  title.className = 'approval-card__title';
  title.textContent = meta.title;
  titleWrap.appendChild(title);

  if (preview) {
    const sub = document.createElement('span');
    sub.className = 'approval-card__subtitle';
    sub.textContent = preview;
    titleWrap.appendChild(sub);
  }
  header.appendChild(titleWrap);

  const approvalTag = document.createElement('span');
  approvalTag.className = 'approval-card__tag';
  approvalTag.textContent = 'Approval needed';
  header.appendChild(approvalTag);

  card.appendChild(header);

  // ── Preview block (per action) ──
  const previewEl = _renderPreview(action, payload);
  if (previewEl) card.appendChild(previewEl);

  // ── Actions ──
  const actions = document.createElement('div');
  actions.className = 'approval-card__actions';

  // For unsubscribe with no method found there's nothing to approve —
  // hide Approve and let the user only dismiss with Reject.
  const hideApprove = action === 'unsubscribe_message'
    && payload && payload.strategy && payload.strategy.method === 'none';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'approval-card__btn approval-card__btn--approve';
  approveBtn.textContent = 'Approve';
  if (hideApprove) approveBtn.style.display = 'none';

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'approval-card__btn approval-card__btn--reject';
  rejectBtn.textContent = hideApprove ? 'Dismiss' : 'Reject';

  approveBtn.addEventListener('click', () => {
    if (card.dataset.decided === '1') return;
    card.dataset.decided = '1';
    _disableButtons(card);
    _setPendingState(card, 'Approved — sending…');
    if (handlers && typeof handlers.onApprove === 'function') handlers.onApprove();
  });

  rejectBtn.addEventListener('click', () => {
    if (card.dataset.decided === '1') return;
    card.dataset.decided = '1';
    _disableButtons(card);
    _setPendingState(card, 'Rejected');
    if (handlers && typeof handlers.onReject === 'function') handlers.onReject();
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  container.appendChild(card);
  _scrollIntoView(container);
  return card;
}

/**
 * Update a card after `mail:approval_resolved` arrives.
 * @param {HTMLElement} card
 * @param {string} status — 'executed' | 'rejected' | 'failed' | 'expired'
 * @param {object} [opts] — { error?: string }
 */
export function setResolvedState(card, status, opts = {}) {
  if (!card) return;
  _disableButtons(card);
  // Remove the actions row once resolved
  const actions = card.querySelector('.approval-card__actions');
  if (actions) actions.remove();
  let existing = card.querySelector('.approval-card__status');
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'approval-card__status';
    card.appendChild(existing);
  }
  existing.className = 'approval-card__status'; // reset modifiers
  existing.textContent = '';

  const label = document.createElement('span');
  label.className = 'approval-card__status-label';

  if (status === 'executed') {
    existing.classList.add('approval-card__status--ok');
    label.textContent = '\u2713 Done';
  } else if (status === 'rejected') {
    existing.classList.add('approval-card__status--rejected');
    label.textContent = '\u2715 Rejected';
  } else if (status === 'expired') {
    existing.classList.add('approval-card__status--expired');
    label.textContent = 'Expired';
  } else {
    existing.classList.add('approval-card__status--fail');
    label.textContent = '\u2715 Failed';
  }
  existing.appendChild(label);

  if (opts.error) {
    const err = document.createElement('span');
    err.className = 'approval-card__status-error';
    err.textContent = opts.error;
    existing.appendChild(err);
  }
}

/**
 * Surface a transient error state against a card (e.g. "already resolved").
 */
export function setErrorState(card, message) {
  if (!card) return;
  _disableButtons(card);
  let existing = card.querySelector('.approval-card__status');
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'approval-card__status';
    card.appendChild(existing);
  }
  existing.className = 'approval-card__status approval-card__status--fail';
  existing.textContent = '';
  const label = document.createElement('span');
  label.className = 'approval-card__status-label';
  label.textContent = '\u2715 ' + (message || 'Error');
  existing.appendChild(label);
}

// ── Internals ────────────────────────────────────────────────────────────

function _disableButtons(card) {
  card.querySelectorAll('.approval-card__btn').forEach(btn => {
    btn.disabled = true;
  });
}

function _setPendingState(card, text) {
  let existing = card.querySelector('.approval-card__status');
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'approval-card__status approval-card__status--pending';
    card.appendChild(existing);
  }
  existing.textContent = text;
}

function _scrollIntoView(container) {
  try { container.scrollTop = container.scrollHeight; } catch (_) { /* ignore */ }
}

// ── Preview renderers per action ─────────────────────────────────────────

function _renderPreview(action, payload) {
  switch (action) {
    case 'send_message':        return _previewSend(payload);
    case 'reply_to_message':    return _previewReply(payload);
    case 'trash_message':       return _previewTargetMessage(payload, 'Trash');
    case 'move_message':        return _previewMove(payload);
    case 'create_event':        return _previewCreateEvent(payload);
    case 'update_event':        return _previewUpdateEvent(payload);
    case 'delete_event':        return _previewDeleteEvent(payload);
    case 'unsubscribe_message': return _previewUnsubscribe(payload);
    default:                    return _previewGeneric(payload);
  }
}

function _previewSend(p) {
  const dl = _dl();
  _addRow(dl, 'To',      _recipientsToString(p.to));
  if (p.cc && _recipientsToString(p.cc)) _addRow(dl, 'Cc', _recipientsToString(p.cc));
  if (p.bcc && _recipientsToString(p.bcc)) _addRow(dl, 'Bcc', _recipientsToString(p.bcc));
  _addRow(dl, 'Subject', p.subject || '(no subject)');
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  const body = _bodyBlock(p.body || p.body_html || p.body_text || '', !!p.body_html);
  if (body) wrap.appendChild(body);
  return wrap;
}

function _previewReply(p) {
  const dl = _dl();
  if (p.subject) _addRow(dl, 'Subject', p.subject);
  if (p.to) _addRow(dl, 'To', _recipientsToString(p.to));
  if (p.cc && _recipientsToString(p.cc)) _addRow(dl, 'Cc', _recipientsToString(p.cc));
  if (p.thread_id || p.message_id) {
    _addRow(dl, 'In reply to', String(p.thread_id || p.message_id));
  }
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  const body = _bodyBlock(p.body || p.body_html || p.body_text || '', !!p.body_html);
  if (body) wrap.appendChild(body);
  return wrap;
}

function _previewTargetMessage(p, verb) {
  const dl = _dl();
  if (p.from) _addRow(dl, 'From', typeof p.from === 'string' ? p.from : (p.from.address || p.from.name || ''));
  if (p.subject) _addRow(dl, 'Subject', p.subject);
  if (p.snippet || p.preview_text) _addRow(dl, 'Preview', p.snippet || p.preview_text);
  if (p.message_id && !p.subject) _addRow(dl, 'Message ID', String(p.message_id));
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  const note = document.createElement('div');
  note.className = 'approval-card__note';
  note.textContent = `Will ${verb.toLowerCase()} the message above.`;
  wrap.appendChild(note);
  return wrap;
}

function _previewMove(p) {
  const dl = _dl();
  if (p.from) _addRow(dl, 'From', typeof p.from === 'string' ? p.from : (p.from.address || ''));
  if (p.subject) _addRow(dl, 'Subject', p.subject);
  if (p.snippet) _addRow(dl, 'Preview', p.snippet);
  if (p.source_folder || p.from_folder) _addRow(dl, 'From folder', p.source_folder || p.from_folder);
  if (p.destination_folder || p.to_folder || p.target_folder) {
    _addRow(dl, 'To folder', p.destination_folder || p.to_folder || p.target_folder);
  }
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  return wrap;
}

function _previewCreateEvent(p) {
  const dl = _dl();
  _addRow(dl, 'Subject', p.subject || p.title || '(no subject)');
  _addRow(dl, 'When', _formatTimeRange(p.start, p.end, p.timezone));
  if (p.location) _addRow(dl, 'Location', p.location);
  if (p.attendees && _recipientsToString(p.attendees)) {
    _addRow(dl, 'Attendees', _recipientsToString(p.attendees));
  }
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  const body = _bodyBlock(p.body || p.description || '', !!p.body_html);
  if (body) wrap.appendChild(body);
  return wrap;
}

function _previewUpdateEvent(p) {
  const dl = _dl();
  _addRow(dl, 'Subject', p.subject || p.title || '(unchanged)');
  if (p.event_id) _addRow(dl, 'Event', String(p.event_id));
  const changes = p.changes || p.diff || {};
  const changedKeys = Object.keys(changes);
  if (changedKeys.length) {
    for (const k of changedKeys) {
      const c = changes[k];
      if (c && typeof c === 'object' && ('from' in c || 'to' in c)) {
        _addRow(dl, k, `${_fmtVal(c.from)} \u2192 ${_fmtVal(c.to)}`);
      } else {
        _addRow(dl, k, _fmtVal(c));
      }
    }
  } else {
    if (p.start || p.end) _addRow(dl, 'When', _formatTimeRange(p.start, p.end, p.timezone));
    if (p.location) _addRow(dl, 'Location', p.location);
  }
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  return wrap;
}

function _previewDeleteEvent(p) {
  const dl = _dl();
  _addRow(dl, 'Subject', p.subject || p.title || '(unknown)');
  if (p.start || p.end) _addRow(dl, 'When', _formatTimeRange(p.start, p.end, p.timezone));
  if (p.event_id) _addRow(dl, 'Event', String(p.event_id));
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  const note = document.createElement('div');
  note.className = 'approval-card__note';
  note.textContent = 'This event will be removed from the calendar.';
  wrap.appendChild(note);
  return wrap;
}

function _previewUnsubscribe(p) {
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';

  const dl = _dl();

  const sender = p && p.sender ? p.sender : {};
  const senderName = sender.name || '';
  const senderEmail = sender.email || '';
  if (senderName || senderEmail) {
    const dt = document.createElement('dt');
    dt.textContent = 'From';
    const dd = document.createElement('dd');
    if (senderName) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = senderName;
      dd.appendChild(nameSpan);
    }
    if (senderEmail) {
      if (senderName) dd.appendChild(document.createTextNode(' '));
      const emailSpan = document.createElement('span');
      emailSpan.className = 'approval-card__email-mono';
      emailSpan.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      emailSpan.style.fontSize = '0.9em';
      emailSpan.textContent = '<' + senderEmail + '>';
      dd.appendChild(emailSpan);
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  if (p && p.subject) _addRow(dl, 'Subject', p.subject);

  const strat = (p && p.strategy) || { method: 'none', target: null };
  const method = strat.method || 'none';

  // Method row (with highlighted target domain / address where applicable).
  const dtMethod = document.createElement('dt');
  dtMethod.textContent = 'Method';
  const ddMethod = document.createElement('dd');
  if (method === 'one_click') {
    ddMethod.appendChild(document.createTextNode('One-click (POST to '));
    const b = document.createElement('b');
    b.textContent = strat.target_domain || _domainFromUrl(strat.target) || '(unknown)';
    ddMethod.appendChild(b);
    ddMethod.appendChild(document.createTextNode(')'));
  } else if (method === 'mailto') {
    ddMethod.appendChild(document.createTextNode('Email to '));
    const b = document.createElement('b');
    b.textContent = strat.target || '(unknown)';
    ddMethod.appendChild(b);
  } else if (method === 'web_link') {
    ddMethod.appendChild(document.createTextNode('Web link — agent will GET '));
    const b = document.createElement('b');
    b.textContent = strat.target_domain || _domainFromUrl(strat.target) || '(unknown)';
    ddMethod.appendChild(b);
  } else {
    ddMethod.textContent = 'No method available';
  }
  dl.appendChild(dtMethod);
  dl.appendChild(ddMethod);

  wrap.appendChild(dl);

  // For web_link, show the full URL in a <code> block so the user knows
  // exactly where they'd be sent before approving.
  if (method === 'web_link' && strat.target) {
    const linkWrap = document.createElement('div');
    linkWrap.className = 'approval-card__body';
    const code = document.createElement('code');
    code.textContent = String(strat.target);
    code.style.wordBreak = 'break-all';
    linkWrap.appendChild(code);
    const note = document.createElement('div');
    note.className = 'approval-card__note';
    note.textContent = "If approved, the backend will follow this link for you. If the sender requires a confirmation click, we'll hand it back so you can open it manually.";
    linkWrap.appendChild(note);
    wrap.appendChild(linkWrap);
  }

  if (method === 'none') {
    const note = document.createElement('div');
    note.className = 'approval-card__note';
    note.textContent = "This email has no List-Unsubscribe header, so there's nothing to approve. Look for an unsubscribe link in the body.";
    wrap.appendChild(note);
  }

  return wrap;
}

function _domainFromUrl(url) {
  try { return new URL(String(url)).hostname; } catch (_) { return ''; }
}

function _previewGeneric(p) {
  const dl = _dl();
  for (const [k, v] of Object.entries(p || {})) {
    _addRow(dl, k, _fmtVal(v));
  }
  const wrap = document.createElement('div');
  wrap.className = 'approval-card__preview';
  wrap.appendChild(dl);
  return wrap;
}

// ── DL / row helpers ─────────────────────────────────────────────────────

function _dl() {
  const dl = document.createElement('dl');
  dl.className = 'approval-card__fields';
  return dl;
}

function _addRow(dl, label, value) {
  if (value === undefined || value === null || value === '') return;
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = String(value);
  dl.appendChild(dt);
  dl.appendChild(dd);
}

// ── Body block (collapsible, text-only) ──────────────────────────────────

function _bodyBlock(rawBody, isHtml) {
  if (!rawBody) return null;
  const text = isHtml ? _stripHtml(rawBody) : String(rawBody);
  if (!text.trim()) return null;

  const wrap = document.createElement('div');
  wrap.className = 'approval-card__body';

  const pre = document.createElement('pre');
  pre.className = 'approval-card__body-text';
  const truncated = text.length > BODY_COLLAPSED_MAX;
  pre.textContent = truncated ? (text.slice(0, BODY_COLLAPSED_MAX) + '\u2026') : text;
  pre.dataset.full = text;
  pre.dataset.truncated = truncated ? '1' : '0';
  wrap.appendChild(pre);

  if (truncated) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'approval-card__body-toggle';
    toggle.textContent = 'Show full';
    let expanded = false;
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        pre.textContent = pre.dataset.full;
        toggle.textContent = 'Show less';
      } else {
        pre.textContent = text.slice(0, BODY_COLLAPSED_MAX) + '\u2026';
        toggle.textContent = 'Show full';
      }
    });
    wrap.appendChild(toggle);
  }
  return wrap;
}

function _stripHtml(html) {
  // Defensive text-only extraction. We never inject HTML; this element is
  // created and read, never appended to the DOM.
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html);
    // Strip <script>/<style> entirely first
    tmp.querySelectorAll('script, style').forEach(el => el.remove());
    return (tmp.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  } catch (_) {
    return String(html);
  }
}

// ── Value formatting ─────────────────────────────────────────────────────

function _recipientsToString(recipients) {
  if (!recipients) return '';
  const arr = Array.isArray(recipients) ? recipients : [recipients];
  return arr.map(r => {
    if (!r) return '';
    if (typeof r === 'string') return r;
    if (r.address && r.name) return `${r.name} <${r.address}>`;
    return r.address || r.email || r.name || '';
  }).filter(Boolean).join(', ');
}

function _formatTimeRange(start, end, tz) {
  const s = _parseDate(start);
  const e = _parseDate(end);
  if (!s && !e) return '';
  try {
    const fmt = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const sStr = s ? s.toLocaleString(undefined, fmt) : '?';
    const eStr = e ? e.toLocaleString(undefined, fmt) : '?';
    const tzStr = tz ? ` (${tz})` : '';
    if (sStr && eStr) return `${sStr} \u2013 ${eStr}${tzStr}`;
    return (sStr || eStr) + tzStr;
  } catch (_) {
    return `${start || ''} \u2013 ${end || ''}`;
  }
}

function _parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function _fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}
