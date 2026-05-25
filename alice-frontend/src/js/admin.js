/**
 * Admin panel — manage the email allowlist and view users.
 *
 * Only wires up UI for admin users. For non-admins, the admin button stays
 * hidden and no other state is touched.
 */

import { fetchJson } from './auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^@[\w.-]+\.[a-z]{2,}$/i;

let _wired = false;
let _currentTab = 'emails';

/**
 * Initialize the admin panel. Shows/hides the #admin-btn based on role,
 * wires button and panel events the first time an admin initializes.
 *
 * @param {object|null} currentUser — the result of getMe()
 */
export function initAdmin(currentUser) {
  const adminBtn = document.getElementById('admin-btn');
  const panel = document.getElementById('admin-panel');
  if (!adminBtn || !panel) return;

  if (!currentUser || currentUser.role !== 'admin') {
    adminBtn.hidden = true;
    return;
  }

  adminBtn.hidden = false;

  if (_wired) return;
  _wired = true;

  adminBtn.addEventListener('click', () => {
    const wasHidden = panel.hidden;
    panel.hidden = false;
    if (wasHidden) _openTab(_currentTab);
  });

  const closeBtn = document.getElementById('admin-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { panel.hidden = true; });

  const tabEmails = document.getElementById('admin-tab-emails');
  const tabUsers = document.getElementById('admin-tab-users');
  if (tabEmails) tabEmails.addEventListener('click', () => _openTab('emails'));
  if (tabUsers) tabUsers.addEventListener('click', () => _openTab('users'));

  // Add form show/hide
  const addToggle = document.getElementById('admin-add-toggle');
  const addForm = document.getElementById('admin-add-form');
  if (addToggle && addForm) {
    addToggle.addEventListener('click', () => { addForm.hidden = !addForm.hidden; });
  }

  const saveBtn = document.getElementById('admin-add-save');
  if (saveBtn) saveBtn.addEventListener('click', _handleAdd);

  const cancelBtn = document.getElementById('admin-add-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    const form = document.getElementById('admin-add-form');
    if (form) form.hidden = true;
    _clearAddForm();
    _setAddError('');
  });
}

function _openTab(tab) {
  _currentTab = tab;
  const tabEmails = document.getElementById('admin-tab-emails');
  const tabUsers = document.getElementById('admin-tab-users');
  const paneEmails = document.getElementById('admin-pane-emails');
  const paneUsers = document.getElementById('admin-pane-users');
  if (tabEmails) tabEmails.classList.toggle('active', tab === 'emails');
  if (tabUsers) tabUsers.classList.toggle('active', tab === 'users');
  if (paneEmails) paneEmails.hidden = tab !== 'emails';
  if (paneUsers) paneUsers.hidden = tab !== 'users';

  if (tab === 'emails') _loadEmails();
  else _loadUsers();
}

async function _loadEmails() {
  const tbody = document.getElementById('admin-emails-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Loading…</td></tr>';
  try {
    const data = await fetchJson('/api/admin/allowed_emails');
    const entries = (data && data.entries) || [];
    _renderEmails(entries);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-error">Failed to load: ${_escape(err.message)}</td></tr>`;
  }
}

function _renderEmails(entries) {
  const tbody = document.getElementById('admin-emails-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">No allowed emails yet.</td></tr>';
    return;
  }
  for (const e of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${_escape(e.email)}</td>
      <td>${_escape(e.role)}</td>
      <td>${e.is_domain ? 'domain' : 'exact'}</td>
      <td>${_escape(e.added_by_username || '')}</td>
      <td>${_escape(_formatDate(e.created_at))}</td>
      <td><button class="admin-del-btn" data-id="${_escape(String(e.id))}">Delete</button></td>
    `;
    const delBtn = tr.querySelector('.admin-del-btn');
    delBtn.addEventListener('click', () => _handleDelete(e.id, e.email));
    if (e.note) tr.title = e.note;
    tbody.appendChild(tr);
  }
}

async function _handleDelete(id, email) {
  if (!confirm(`Remove ${email} from the allowlist?`)) return;
  try {
    await fetchJson(`/api/admin/allowed_emails/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await _loadEmails();
  } catch (err) {
    if (err.status !== 403) alert(`Failed to delete: ${err.message}`);
  }
}

async function _handleAdd() {
  const emailEl = document.getElementById('admin-add-email');
  const roleEl = document.getElementById('admin-add-role');
  const domainEl = document.getElementById('admin-add-domain');
  const noteEl = document.getElementById('admin-add-note');
  if (!emailEl || !roleEl || !domainEl) return;

  const email = emailEl.value.trim();
  const role = roleEl.value;
  const isDomain = !!domainEl.checked;
  const note = noteEl ? noteEl.value.trim() : '';

  // Client-side validation
  if (isDomain) {
    if (!DOMAIN_RE.test(email)) {
      _setAddError('Domain must look like @example.com');
      return;
    }
  } else {
    if (!EMAIL_RE.test(email)) {
      _setAddError('Enter a valid email address');
      return;
    }
  }
  if (role !== 'user' && role !== 'admin') {
    _setAddError('Role must be user or admin');
    return;
  }
  _setAddError('');

  const saveBtn = document.getElementById('admin-add-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await fetchJson('/api/admin/allowed_emails', {
      method: 'POST',
      body: { email, role, is_domain: isDomain, note: note || undefined },
    });
    _clearAddForm();
    const form = document.getElementById('admin-add-form');
    if (form) form.hidden = true;
    await _loadEmails();
  } catch (err) {
    if (err.status !== 403) {
      _setAddError(err.body || err.message || 'Failed to add');
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function _clearAddForm() {
  const emailEl = document.getElementById('admin-add-email');
  const roleEl = document.getElementById('admin-add-role');
  const domainEl = document.getElementById('admin-add-domain');
  const noteEl = document.getElementById('admin-add-note');
  if (emailEl) emailEl.value = '';
  if (roleEl) roleEl.value = 'user';
  if (domainEl) domainEl.checked = false;
  if (noteEl) noteEl.value = '';
}

function _setAddError(msg) {
  const el = document.getElementById('admin-add-error');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function _loadUsers() {
  const tbody = document.getElementById('admin-users-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">Loading…</td></tr>';
  try {
    const data = await fetchJson('/api/admin/users');
    const users = (data && data.users) || [];
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">No users yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${_escape(u.email || '')}</td>
        <td>${_escape(u.display_name || '')}</td>
        <td>${_escape(u.role || '')}</td>
        <td>${_escape(u.auth_provider || '')}</td>
        <td>${_escape(_formatDate(u.created_at))}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-error">Failed to load: ${_escape(err.message)}</td></tr>`;
  }
}

function _formatDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString();
  } catch {
    return String(v);
  }
}

function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
