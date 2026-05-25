/**
 * Mail & Calendar panel — consume /api/mail/*.
 *
 * Three tabs inside the panel:
 *   - Accounts: connect/disconnect Microsoft and Google inboxes.
 *   - Inbox:    list + read messages with a sandboxed iframe reader.
 *   - Calendar: event list grouped by day across a date range.
 *
 * All network I/O goes through fetchJson() from auth.js so cookies and CSRF
 * are handled centrally. No tokens are stored locally.
 *
 * HTML bodies are rendered inside an <iframe sandbox="allow-same-origin">
 * via the srcdoc attribute. We do NOT set allow-scripts — the iframe is the
 * real defence and a belt-and-braces <script> strip runs before srcdoc.
 */

import { fetchJson, AuthError } from './auth.js';

const FOLDERS = [
  { id: 'inbox',  label: 'Inbox'  },
  { id: 'sent',   label: 'Sent'   },
  { id: 'drafts', label: 'Drafts' },
  { id: 'trash',  label: 'Trash'  },
];

const SEARCH_DEBOUNCE_MS = 400;
const MESSAGE_LIMIT = 25;

// ── Module state (in-memory only) ────────────────────────────────────────
let _wired = false;
let _currentTab = 'accounts';
let _accounts = null;              // cached account list, null = not yet loaded
let _selectedAccountId = null;
let _selectedFolder = 'inbox';
let _messages = [];
let _openMessageId = null;
let _searchDebounceTimer = null;
let _inFlightMessagesAbort = null; // AbortController for list search
let _calendarRange = null;         // { from: Date, to: Date }

/**
 * Initialise the mail module. Shows the Mail header button for all
 * authenticated users and wires event handlers once.
 *
 * @param {object|null} currentUser — result of getMe()
 */
export function initMail(currentUser) {
  const mailBtn = document.getElementById('mail-btn');
  const panel   = document.getElementById('mail-panel');
  if (!mailBtn || !panel) return;

  if (!currentUser) {
    mailBtn.hidden = true;
    return;
  }
  mailBtn.hidden = false;

  // Handle OAuth round-trip query params regardless of whether we've wired yet.
  _consumeUrlBanner();

  if (_wired) return;
  _wired = true;

  mailBtn.addEventListener('click', () => {
    const wasHidden = panel.hidden;
    panel.hidden = false;
    if (wasHidden) {
      _openTab(_currentTab || 'accounts');
      // First open: load accounts so other tabs have data.
      if (_accounts === null) _loadAccounts();
    }
  });

  const closeBtn = document.getElementById('mail-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { panel.hidden = true; });

  _wireTabs();
  _wireAccountsPane();
  _wireInboxPane();
  _wireCalendarPane();

  // Default calendar range: today → +7 days
  _calendarRange = _quickRange(7);
}

// ── URL banner (OAuth round-trip) ────────────────────────────────────────

function _consumeUrlBanner() {
  let params;
  try { params = new URLSearchParams(window.location.search); }
  catch { return; }

  const connected = params.get('mail_connected');
  const errSlug   = params.get('mail_error');
  if (!connected && !errSlug) return;

  if (connected) _showBanner(`Connected ${_prettyProvider(connected)} successfully.`, 'ok');
  else if (errSlug) _showBanner(`Mail connection failed: ${_humaniseSlug(errSlug)}`, 'err');

  try {
    params.delete('mail_connected');
    params.delete('mail_error');
    const qs = params.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState({}, '', url);
  } catch (_) { /* best-effort */ }

  // After a successful connect we should refresh the accounts cache next time.
  if (connected) _accounts = null;
}

function _showBanner(text, kind) {
  const el = document.getElementById('mail-banner');
  if (!el) {
    // Fallback: use a brief toast-style alert; avoids blocking UX in tests.
    console.info(`[mail] ${text}`);
    return;
  }
  el.textContent = text;
  el.className = `mail-banner mail-banner-${kind === 'ok' ? 'ok' : 'err'}`;
  el.hidden = false;
  // Auto-hide after 6s
  setTimeout(() => { el.hidden = true; }, 6000);
}

// ── Tabs ────────────────────────────────────────────────────────────────

function _wireTabs() {
  const map = { accounts: 'mail-tab-accounts', inbox: 'mail-tab-inbox', calendar: 'mail-tab-calendar' };
  for (const [tab, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => _openTab(tab));
  }
}

function _openTab(tab) {
  _currentTab = tab;
  const tabs  = ['accounts', 'inbox', 'calendar'];
  for (const t of tabs) {
    const tabBtn = document.getElementById(`mail-tab-${t}`);
    const pane   = document.getElementById(`mail-pane-${t}`);
    if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    if (pane)   pane.hidden = t !== tab;
  }

  if (tab === 'accounts') _renderAccounts();
  else if (tab === 'inbox') _enterInbox();
  else if (tab === 'calendar') _enterCalendar();
}

// ── Accounts pane ────────────────────────────────────────────────────────

function _wireAccountsPane() {
  const refreshBtn = document.getElementById('mail-accounts-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => _loadAccounts(true));

  const msBtn = document.getElementById('mail-connect-ms');
  if (msBtn) msBtn.addEventListener('click', () => _startConnect('microsoft'));

  const ggBtn = document.getElementById('mail-connect-google');
  if (ggBtn) ggBtn.addEventListener('click', () => _startConnect('google'));
}

function _startConnect(provider) {
  if (provider !== 'microsoft' && provider !== 'google') return;
  // Plain navigation — backend redirects to provider consent, then back here
  // with ?mail_connected=<provider> or ?mail_error=<slug>.
  window.location.href = `/api/mail/connect/${provider}/start`;
}

async function _loadAccounts(force = false) {
  if (!force && _accounts !== null) {
    _renderAccounts();
    return;
  }
  const listEl = document.getElementById('mail-accounts-list');
  if (listEl) listEl.innerHTML = '<p class="mail-empty">Loading…</p>';
  try {
    const data = await fetchJson('/api/mail/accounts');
    _accounts = (data && Array.isArray(data.accounts)) ? data.accounts : [];
  } catch (err) {
    if (err instanceof AuthError) return;
    _accounts = [];
    if (listEl) listEl.innerHTML = `<p class="mail-error">Failed to load accounts: ${_escape(err.message || 'unknown error')}</p>`;
    return;
  }
  _renderAccounts();
  _populateAccountSelect();
}

function _renderAccounts() {
  const listEl = document.getElementById('mail-accounts-list');
  if (!listEl) return;
  if (_accounts === null) {
    listEl.innerHTML = '<p class="mail-empty">Loading…</p>';
    return;
  }
  if (!_accounts.length) {
    listEl.innerHTML = '<p class="mail-empty">No connected accounts yet. Connect Microsoft or Google above.</p>';
    return;
  }
  listEl.innerHTML = '';
  for (const acct of _accounts) {
    const row = document.createElement('div');
    row.className = 'mail-account-row';

    const left = document.createElement('div');
    left.className = 'mail-account-info';
    const prov = document.createElement('span');
    prov.className = 'mail-account-provider';
    prov.textContent = _prettyProvider(acct.provider);
    const email = document.createElement('span');
    email.className = 'mail-account-email';
    email.textContent = acct.email || acct.display_name || '(no address)';
    const status = document.createElement('span');
    const statusClass = _statusClass(acct.status);
    status.className = `mail-status-badge ${statusClass}`;
    status.textContent = _statusLabel(acct.status);
    left.appendChild(prov);
    left.appendChild(email);
    left.appendChild(status);

    const right = document.createElement('div');
    right.className = 'mail-account-actions';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mail-btn-danger';
    delBtn.textContent = 'Disconnect';
    delBtn.addEventListener('click', () => _disconnectAccount(acct));
    right.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(right);
    listEl.appendChild(row);
  }
}

async function _disconnectAccount(acct) {
  const label = acct.email || _prettyProvider(acct.provider);
  if (!confirm(`Disconnect ${label}? You can reconnect later.`)) return;
  try {
    await fetchJson(`/api/mail/accounts/${encodeURIComponent(acct.id)}`, { method: 'DELETE' });
    _accounts = (_accounts || []).filter(a => a.id !== acct.id);
    if (_selectedAccountId === acct.id) {
      _selectedAccountId = null;
      _messages = [];
      _openMessageId = null;
      _renderMessageList();
      _renderReader(null);
    }
    _renderAccounts();
    _populateAccountSelect();
  } catch (err) {
    if (err instanceof AuthError) return;
    if (err.status !== 403) alert(`Failed to disconnect: ${err.message || 'unknown error'}`);
  }
}

// ── Inbox pane ───────────────────────────────────────────────────────────

function _wireInboxPane() {
  const acctSel = document.getElementById('mail-inbox-account');
  if (acctSel) acctSel.addEventListener('change', () => {
    _selectedAccountId = acctSel.value || null;
    _openMessageId = null;
    _renderReader(null);
    _loadMessages();
  });

  const folderSel = document.getElementById('mail-inbox-folder');
  if (folderSel) folderSel.addEventListener('change', () => {
    _selectedFolder = folderSel.value || 'inbox';
    _openMessageId = null;
    _renderReader(null);
    _loadMessages();
  });

  const searchEl = document.getElementById('mail-inbox-search');
  if (searchEl) searchEl.addEventListener('input', () => {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => _loadMessages(), SEARCH_DEBOUNCE_MS);
  });

  const refreshBtn = document.getElementById('mail-inbox-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => _loadMessages());
}

function _enterInbox() {
  if (_accounts === null) {
    _loadAccounts().then(() => _populateAccountSelect());
    return;
  }
  _populateAccountSelect();
  if (_selectedAccountId) _loadMessages();
  else _renderMessageList();
}

function _populateAccountSelect() {
  const sel = document.getElementById('mail-inbox-account');
  if (!sel) return;
  const prev = _selectedAccountId || sel.value;
  sel.innerHTML = '';

  const accts = _accounts || [];
  if (!accts.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No connected accounts';
    sel.appendChild(opt);
    sel.disabled = true;
    _selectedAccountId = null;
    _renderMessageList();
    return;
  }
  sel.disabled = false;
  for (const acct of accts) {
    const opt = document.createElement('option');
    opt.value = acct.id;
    opt.textContent = `${_prettyProvider(acct.provider)} — ${acct.email || '(no address)'}`;
    sel.appendChild(opt);
  }
  // Pick the previously-selected account if still present, else first.
  const ids = accts.map(a => a.id);
  const next = ids.includes(prev) ? prev : accts[0].id;
  sel.value = next;
  _selectedAccountId = next;

  // Folder select
  const folderSel = document.getElementById('mail-inbox-folder');
  if (folderSel && !folderSel.options.length) {
    for (const f of FOLDERS) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.label;
      folderSel.appendChild(opt);
    }
    folderSel.value = _selectedFolder;
  }
}

async function _loadMessages() {
  const listEl = document.getElementById('mail-message-list');
  if (!listEl) return;
  if (!_selectedAccountId) {
    listEl.innerHTML = '<p class="mail-empty">Select an account.</p>';
    return;
  }
  // Cancel any in-flight search
  if (_inFlightMessagesAbort) {
    try { _inFlightMessagesAbort.abort(); } catch (_) {}
  }
  const controller = new AbortController();
  _inFlightMessagesAbort = controller;

  const searchEl = document.getElementById('mail-inbox-search');
  const q = searchEl ? searchEl.value.trim() : '';
  const url = `/api/mail/accounts/${encodeURIComponent(_selectedAccountId)}/messages`
    + `?folder=${encodeURIComponent(_selectedFolder)}`
    + `&limit=${MESSAGE_LIMIT}`
    + (q ? `&q=${encodeURIComponent(q)}` : '');

  listEl.innerHTML = '<p class="mail-empty">Loading…</p>';
  try {
    const data = await fetchJson(url, { signal: controller.signal });
    if (controller.signal.aborted) return;
    _messages = (data && Array.isArray(data.messages)) ? data.messages : [];
    _renderMessageList();
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') return;
    if (err instanceof AuthError) return;
    _messages = [];
    listEl.innerHTML = `<p class="mail-error">Failed to load messages: ${_escape(err.message || 'unknown error')}</p>`;
  } finally {
    if (_inFlightMessagesAbort === controller) _inFlightMessagesAbort = null;
  }
}

function _renderMessageList() {
  const listEl = document.getElementById('mail-message-list');
  if (!listEl) return;
  if (!_selectedAccountId) {
    listEl.innerHTML = '<p class="mail-empty">Select an account.</p>';
    return;
  }
  if (!_messages.length) {
    listEl.innerHTML = '<p class="mail-empty">No messages.</p>';
    return;
  }
  listEl.innerHTML = '';
  for (const msg of _messages) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mail-msg-row' + (msg.unread ? ' mail-msg-unread' : '') + (msg.id === _openMessageId ? ' mail-msg-selected' : '');
    item.dataset.id = msg.id;

    const fromName = (msg.from && (msg.from.name || msg.from.email)) || 'Unknown';
    const subject  = msg.subject || '(no subject)';
    const snippet  = msg.snippet || '';
    const dateStr  = _formatShortDate(msg.date);
    const clip     = msg.hasAttachments ? '<span class="mail-clip" title="Has attachments">📎</span>' : '';

    item.innerHTML = `
      <div class="mail-msg-top">
        <span class="mail-msg-from">${_escape(fromName)}</span>
        <span class="mail-msg-date">${_escape(dateStr)}</span>
      </div>
      <div class="mail-msg-subject">${_escape(subject)} ${clip}</div>
      <div class="mail-msg-snippet">${_escape(snippet)}</div>
    `;
    item.addEventListener('click', () => _openMessage(msg.id));
    listEl.appendChild(item);
  }
}

async function _openMessage(msgId) {
  if (!_selectedAccountId || !msgId) return;
  _openMessageId = msgId;
  // Update selection styling
  document.querySelectorAll('.mail-msg-row').forEach(el => {
    el.classList.toggle('mail-msg-selected', el.dataset.id === msgId);
  });
  _renderReader({ loading: true });
  try {
    const url = `/api/mail/accounts/${encodeURIComponent(_selectedAccountId)}/messages/${encodeURIComponent(msgId)}`;
    const data = await fetchJson(url);
    const message = (data && data.message) ? data.message : null;
    _renderReader(message);
  } catch (err) {
    if (err instanceof AuthError) return;
    _renderReader({ error: err.message || 'Failed to load message' });
  }
}

function _renderReader(state) {
  const readerEl = document.getElementById('mail-reader');
  if (!readerEl) return;

  if (state == null) {
    readerEl.innerHTML = '<p class="mail-empty">Select a message to read.</p>';
    return;
  }
  if (state.loading) {
    readerEl.innerHTML = '<p class="mail-empty">Loading message…</p>';
    return;
  }
  if (state.error) {
    readerEl.innerHTML = `<p class="mail-error">${_escape(state.error)}</p>`;
    return;
  }

  const msg = state;
  const from = _formatAddress(msg.from);
  const to   = _formatAddressList(msg.to);
  const cc   = _formatAddressList(msg.cc);
  const bcc  = _formatAddressList(msg.bcc);
  const subject = msg.subject || '(no subject)';
  const date = _formatFullDate(msg.date);

  // Build header (escaped) + body frame shell
  const headerHtml = `
    <div class="mail-reader-head">
      <h3 class="mail-reader-subject">${_escape(subject)}</h3>
      <div class="mail-reader-meta">
        <div><span class="mail-meta-label">From:</span> ${_escape(from)}</div>
        ${to  ? `<div><span class="mail-meta-label">To:</span> ${_escape(to)}</div>` : ''}
        ${cc  ? `<div><span class="mail-meta-label">Cc:</span> ${_escape(cc)}</div>` : ''}
        ${bcc ? `<div><span class="mail-meta-label">Bcc:</span> ${_escape(bcc)}</div>` : ''}
        ${date ? `<div class="mail-meta-date">${_escape(date)}</div>` : ''}
      </div>
      ${_renderAttachmentsBlock(msg.attachments)}
    </div>
    <div class="mail-reader-body" id="mail-reader-body"></div>
  `;
  readerEl.innerHTML = headerHtml;

  const bodyEl = document.getElementById('mail-reader-body');
  if (!bodyEl) return;
  if (msg.body_html && typeof msg.body_html === 'string') {
    const iframe = document.createElement('iframe');
    iframe.className = 'mail-reader-iframe';
    // sandbox WITHOUT allow-scripts. allow-same-origin lets base styling work.
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', 'Email body');
    iframe.srcdoc = _wrapSrcdoc(_stripScripts(msg.body_html));
    bodyEl.appendChild(iframe);
  } else if (msg.body_text) {
    const pre = document.createElement('pre');
    pre.className = 'mail-reader-text';
    pre.textContent = String(msg.body_text);
    bodyEl.appendChild(pre);
  } else {
    bodyEl.innerHTML = '<p class="mail-empty">(No body.)</p>';
  }
}

function _renderAttachmentsBlock(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const rows = attachments.map(a => {
    const name = a.filename || a.name || 'attachment';
    const size = a.size_bytes ? ` (${Math.round(a.size_bytes / 1024)} KB)` : '';
    return `<li>📎 ${_escape(name)}${_escape(size)}</li>`;
  }).join('');
  return `<ul class="mail-attachments">${rows}</ul>`;
}

// ── Calendar pane ────────────────────────────────────────────────────────

function _wireCalendarPane() {
  const fromEl = document.getElementById('mail-cal-from');
  const toEl   = document.getElementById('mail-cal-to');
  const loadBtn = document.getElementById('mail-cal-load');
  if (loadBtn) loadBtn.addEventListener('click', () => {
    const f = fromEl && fromEl.value ? new Date(fromEl.value) : null;
    const t = toEl   && toEl.value   ? new Date(toEl.value)   : null;
    if (f && t && !isNaN(f.getTime()) && !isNaN(t.getTime())) {
      _calendarRange = { from: f, to: t };
      _loadEvents();
    }
  });

  const today = document.getElementById('mail-cal-today');
  const next7 = document.getElementById('mail-cal-next7');
  const next30 = document.getElementById('mail-cal-next30');
  if (today)  today.addEventListener('click',  () => { _calendarRange = _quickRange(1);  _reflectRange(); _loadEvents(); });
  if (next7)  next7.addEventListener('click',  () => { _calendarRange = _quickRange(7);  _reflectRange(); _loadEvents(); });
  if (next30) next30.addEventListener('click', () => { _calendarRange = _quickRange(30); _reflectRange(); _loadEvents(); });

  const acctSel = document.getElementById('mail-cal-account');
  if (acctSel) acctSel.addEventListener('change', () => _loadEvents());
}

function _enterCalendar() {
  if (_accounts === null) {
    _loadAccounts().then(() => _populateCalendarAccountSelect());
    return;
  }
  _populateCalendarAccountSelect();
  _reflectRange();
  _loadEvents();
}

function _populateCalendarAccountSelect() {
  const sel = document.getElementById('mail-cal-account');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const accts = _accounts || [];
  if (!accts.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No connected accounts';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const acct of accts) {
    const opt = document.createElement('option');
    opt.value = acct.id;
    opt.textContent = `${_prettyProvider(acct.provider)} — ${acct.email || '(no address)'}`;
    sel.appendChild(opt);
  }
  const ids = accts.map(a => a.id);
  sel.value = ids.includes(prev) ? prev : accts[0].id;
}

function _reflectRange() {
  const fromEl = document.getElementById('mail-cal-from');
  const toEl   = document.getElementById('mail-cal-to');
  if (!_calendarRange) return;
  if (fromEl) fromEl.value = _toDateInput(_calendarRange.from);
  if (toEl)   toEl.value   = _toDateInput(_calendarRange.to);
}

async function _loadEvents() {
  const listEl = document.getElementById('mail-cal-list');
  if (!listEl) return;
  const sel = document.getElementById('mail-cal-account');
  const acctId = sel && sel.value ? sel.value : null;
  if (!acctId) {
    listEl.innerHTML = '<p class="mail-empty">Connect an account to see calendar events.</p>';
    return;
  }
  if (!_calendarRange) _calendarRange = _quickRange(7);
  const fromIso = _calendarRange.from.toISOString();
  const toIso   = _calendarRange.to.toISOString();
  const url = `/api/mail/accounts/${encodeURIComponent(acctId)}/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  listEl.innerHTML = '<p class="mail-empty">Loading events…</p>';
  try {
    const data = await fetchJson(url);
    const events = (data && Array.isArray(data.events)) ? data.events : [];
    _renderEvents(events);
  } catch (err) {
    if (err instanceof AuthError) return;
    listEl.innerHTML = `<p class="mail-error">Failed to load events: ${_escape(err.message || 'unknown error')}</p>`;
  }
}

function _renderEvents(events) {
  const listEl = document.getElementById('mail-cal-list');
  if (!listEl) return;
  if (!events.length) {
    listEl.innerHTML = '<p class="mail-empty">No events in this range.</p>';
    return;
  }
  // Group by day (local date)
  const groups = new Map();
  for (const ev of events) {
    const d = ev.start ? new Date(ev.start) : null;
    const key = d && !isNaN(d.getTime()) ? _toDateInput(d) : 'unscheduled';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  listEl.innerHTML = '';
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const dayHeader = document.createElement('h4');
    dayHeader.className = 'mail-cal-day-header';
    dayHeader.textContent = key === 'unscheduled' ? 'Unscheduled' : _formatDayHeader(key);
    listEl.appendChild(dayHeader);

    for (const ev of groups.get(key)) {
      const card = document.createElement('details');
      card.className = 'mail-cal-event';

      const summary = document.createElement('summary');
      summary.className = 'mail-cal-event-summary';
      const time = ev.is_all_day
        ? 'All day'
        : `${_formatTime(ev.start)}${ev.end ? ' – ' + _formatTime(ev.end) : ''}`;
      summary.innerHTML = `
        <span class="mail-cal-event-time">${_escape(time)}</span>
        <span class="mail-cal-event-subject">${_escape(ev.subject || '(no subject)')}</span>
      `;
      card.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'mail-cal-event-body';
      const rows = [];
      if (ev.location)  rows.push(`<div><span class="mail-meta-label">Location:</span> ${_escape(ev.location)}</div>`);
      if (ev.organizer) rows.push(`<div><span class="mail-meta-label">Organiser:</span> ${_escape(_formatAddress(ev.organizer))}</div>`);
      if (Array.isArray(ev.attendees) && ev.attendees.length) {
        rows.push(`<div><span class="mail-meta-label">Attendees:</span> ${_escape(_formatAddressList(ev.attendees))}</div>`);
      }
      if (ev.body_preview) rows.push(`<div class="mail-cal-event-preview">${_escape(ev.body_preview)}</div>`);
      body.innerHTML = rows.join('');
      card.appendChild(body);

      listEl.appendChild(card);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _statusLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'needs_reconnect') return 'Reconnect';
  if (status === 'error') return 'Error';
  return status || 'Unknown';
}

function _statusClass(status) {
  if (status === 'active') return 'mail-status-active';
  if (status === 'needs_reconnect') return 'mail-status-needs_reconnect';
  if (status === 'error') return 'mail-status-error';
  return 'mail-status-unknown';
}

function _prettyProvider(p) {
  if (p === 'microsoft') return 'Microsoft';
  if (p === 'google') return 'Google';
  return p ? String(p).charAt(0).toUpperCase() + String(p).slice(1) : 'Unknown';
}

function _humaniseSlug(slug) {
  return String(slug || '').replace(/[_-]+/g, ' ').trim() || 'unknown error';
}

function _quickRange(days) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime());
  to.setDate(to.getDate() + Math.max(1, days));
  return { from, to };
}

function _toDateInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _formatDayHeader(yyyyMmDd) {
  try {
    const [y, m, d] = yyyyMmDd.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    if (isNaN(dt.getTime())) return yyyyMmDd;
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return yyyyMmDd;
  }
}

function _formatShortDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(v);
  }
}

function _formatFullDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch {
    return String(v);
  }
}

function _formatTime(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(v);
  }
}

function _formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  if (addr.name && addr.email) return `${addr.name} <${addr.email}>`;
  return addr.name || addr.email || '';
}

function _formatAddressList(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map(_formatAddress).filter(Boolean).join(', ');
}

/**
 * Belt-and-braces <script> stripper. The real defence is the iframe sandbox
 * (no allow-scripts). We additionally strip <script>...</script>, inline
 * event handlers, and javascript: URLs before setting srcdoc so malicious
 * HTML never runs even if a browser misbehaves.
 */
function _stripScripts(html) {
  let out = String(html);
  // <script> blocks (including self-closing and with attributes)
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  // Inline event handlers like onclick="..."
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  // javascript: URLs in href / src
  out = out.replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
  return out;
}

function _wrapSrcdoc(innerHtml) {
  // Minimal reset so the iframe shows readable text regardless of email CSS.
  const style = `
    <style>
      html, body { margin: 0; padding: 12px; background: #fff; color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; }
      img { max-width: 100%; height: auto; }
      a { color: #0366d6; }
      pre, code { white-space: pre-wrap; word-break: break-word; }
      table { max-width: 100%; }
    </style>
  `;
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${innerHtml}</body></html>`;
}

function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
