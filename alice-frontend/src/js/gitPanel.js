/**
 * GitPanel — VS Code-ish Source Control panel for the code view.
 *
 * Surfaces:
 *   - Branch pill + ahead/behind indicator + Push / Pull
 *   - Changes: staged / unstaged / untracked, each file has inline actions
 *     (stage, unstage, view diff)
 *   - Commit message box + Commit button
 *   - Recent history (tap commit to view diff-from-parent — not in v1)
 *
 * Expects `api.fetchJson(path, opts)` to be provided by the host so it can
 * reuse the project's auth/CSRF plumbing. Host also provides the Monaco
 * `editor` so clicking "view diff" opens Monaco's diff viewer.
 */

export class GitPanel {
  /**
   * @param {HTMLElement} containerEl
   * @param {object} deps
   * @param {(path: string, opts?: object) => Promise<any>} deps.apiFetch
   * @param {import('./editor.js').Editor} deps.editor
   * @param {{ appendOutput: (s: string) => void }} deps.terminal
   */
  constructor(containerEl, { apiFetch, editor, terminal }) {
    this._root = containerEl;
    this._api = apiFetch;
    this._editor = editor;
    this._terminal = terminal;
    this._projectId = null;
    this._status = null;
    this._log = [];
    this._refreshing = false;
    this._buildUi();
  }

  setProjectId(id) {
    this._projectId = id;
    this.refresh();
  }

  /** Call from the host whenever files change on disk (agent writes, save, etc.). */
  async refresh() {
    if (!this._projectId || this._refreshing) return;
    this._refreshing = true;
    try {
      const status = await this._api(`/git/${this._projectId}/status`);
      this._status = status;
      if (status.repo) {
        const log = await this._api(`/git/${this._projectId}/log?limit=15`).catch(() => ({ commits: [] }));
        this._log = log.commits || [];
      } else {
        this._log = [];
      }
    } catch (err) {
      this._status = { error: err?.message || 'git status failed' };
    } finally {
      this._refreshing = false;
      this._render();
    }
  }

  // ── UI ────────────────────────────────────────────────────────────

  _buildUi() {
    this._root.innerHTML = '';
    this._root.classList.add('git-panel');

    this._headerEl = this._div('git-header');
    this._branchPill = this._div('git-branch-pill');
    this._branchPill.textContent = '—';
    this._branchPill.title = 'Current branch';
    this._syncRow = this._div('git-sync-row');
    this._headerEl.append(this._branchPill, this._syncRow);

    this._statusEl = this._div('git-status-msg');
    this._changesEl = this._div('git-changes');
    this._commitBoxEl = this._div('git-commit-box');
    this._logEl = this._div('git-log');

    this._root.append(this._headerEl, this._statusEl, this._changesEl, this._commitBoxEl, this._logEl);
    // Minimal self-contained styling — the app's main CSS can override later.
    this._injectStyles();
  }

  _render() {
    if (!this._projectId) {
      this._statusEl.textContent = 'Select a project.';
      this._branchPill.textContent = '—';
      this._syncRow.innerHTML = '';
      this._changesEl.innerHTML = '';
      this._commitBoxEl.innerHTML = '';
      this._logEl.innerHTML = '';
      return;
    }

    if (this._status && this._status.error) {
      this._statusEl.textContent = `Error: ${this._status.error}`;
      return;
    }

    if (this._status && !this._status.repo) {
      this._statusEl.textContent = 'Not a git repository.';
      this._changesEl.innerHTML = '';
      this._commitBoxEl.innerHTML = '';
      this._logEl.innerHTML = '';
      this._branchPill.textContent = '—';
      this._syncRow.innerHTML = '';
      const initBtn = this._btn('Initialise git repo', () => this._doInit());
      this._changesEl.appendChild(initBtn);
      return;
    }

    if (!this._status) {
      this._statusEl.textContent = 'Loading…';
      return;
    }

    this._statusEl.textContent = '';
    const s = this._status;
    this._branchPill.textContent = s.branch || '(detached)';
    this._syncRow.innerHTML = '';
    const ab = [];
    if (s.ahead) ab.push(`↑${s.ahead}`);
    if (s.behind) ab.push(`↓${s.behind}`);
    if (ab.length) {
      const span = this._div('git-ab');
      span.textContent = ab.join(' ');
      this._syncRow.appendChild(span);
    }
    const pullBtn = this._btn('Pull', () => this._doPull());
    const pushBtn = this._btn('Push', () => this._doPush());
    pullBtn.classList.add('git-btn-sm');
    pushBtn.classList.add('git-btn-sm');
    if (!s.tracking) { pullBtn.disabled = true; pushBtn.disabled = true; pullBtn.title = pushBtn.title = 'No upstream tracked — set a remote first'; }
    this._syncRow.append(pullBtn, pushBtn);

    this._renderChanges();
    this._renderCommitBox();
    this._renderLog();
  }

  _renderChanges() {
    this._changesEl.innerHTML = '';
    const { files, hasStaged, hasUnstaged } = this._status;
    const staged = files.filter(f => f.staged);
    const unstagedOrUntracked = files.filter(f => !f.staged);

    if (!files.length) {
      const clean = this._div('git-clean');
      clean.textContent = '✓ Working tree clean';
      this._changesEl.appendChild(clean);
      return;
    }

    if (staged.length) {
      this._renderGroup('Staged Changes', staged, true);
    }
    if (unstagedOrUntracked.length) {
      this._renderGroup('Changes', unstagedOrUntracked, false);
    }
  }

  _renderGroup(title, items, staged) {
    const header = this._div('git-group-header');
    const heading = document.createElement('strong');
    heading.textContent = `${title}  `;
    const count = document.createElement('span');
    count.className = 'git-count';
    count.textContent = items.length;
    header.append(heading, count);
    const actions = this._div('git-group-actions');
    if (staged) {
      actions.appendChild(this._btn('Unstage all', () => this._bulk('unstage', 'all')));
    } else {
      actions.appendChild(this._btn('Stage all', () => this._bulk('stage', 'all')));
    }
    header.appendChild(actions);
    this._changesEl.appendChild(header);

    for (const f of items) {
      const row = this._div('git-file-row');
      row.title = f.path;
      const label = this._div('git-file-label');
      const badge = document.createElement('span');
      badge.className = 'git-badge';
      badge.textContent = this._shortStatus(f);
      badge.title = `index:${f.index || ' '}  worktree:${f.working || ' '}`;
      const name = document.createElement('span');
      name.className = 'git-file-name';
      name.textContent = f.path;
      label.append(badge, name);

      const act = this._div('git-file-actions');
      const diffBtn = this._btn('Diff', () => this._viewDiff(f, staged));
      diffBtn.classList.add('git-btn-xs');
      act.appendChild(diffBtn);
      if (staged) {
        const unstage = this._btn('−', () => this._bulk('unstage', [f.path]));
        unstage.classList.add('git-btn-xs');
        unstage.title = 'Unstage this file';
        act.appendChild(unstage);
      } else {
        const stage = this._btn('+', () => this._bulk('stage', [f.path]));
        stage.classList.add('git-btn-xs');
        stage.title = 'Stage this file';
        act.appendChild(stage);
      }
      row.append(label, act);
      label.addEventListener('dblclick', () => this._viewDiff(f, staged));
      this._changesEl.appendChild(row);
    }
  }

  _renderCommitBox() {
    this._commitBoxEl.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'git-commit-input';
    ta.rows = 2;
    ta.placeholder = 'Commit message (Ctrl/Cmd+Enter to commit)';
    const btnRow = this._div('git-commit-btn-row');
    const commitBtn = this._btn('Commit', () => this._doCommit(ta.value));
    commitBtn.classList.add('git-btn-primary');
    const commitAllBtn = this._btn('Stage all + Commit', () => this._doStageAllAndCommit(ta.value));
    commitAllBtn.classList.add('git-btn-sm');
    btnRow.append(commitBtn, commitAllBtn);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this._doCommit(ta.value);
      }
    });
    this._commitBoxEl.append(ta, btnRow);
  }

  _renderLog() {
    this._logEl.innerHTML = '';
    if (!this._log.length) return;
    const h = this._div('git-log-header');
    h.textContent = 'History';
    this._logEl.appendChild(h);
    for (const c of this._log) {
      const row = this._div('git-log-row');
      const top = this._div('git-log-top');
      const hash = document.createElement('span');
      hash.className = 'git-log-hash';
      hash.textContent = c.short;
      const msg = document.createElement('span');
      msg.className = 'git-log-msg';
      msg.textContent = c.message;
      top.append(hash, msg);
      const sub = this._div('git-log-sub');
      sub.textContent = `${c.author || '(unknown)'} · ${this._relativeTime(c.date)}`;
      row.append(top, sub);
      row.title = `${c.hash}\n${c.message}`;
      this._logEl.appendChild(row);
    }
  }

  // ── Actions ───────────────────────────────────────────────────────

  async _doInit() {
    try {
      await this._api(`/git/${this._projectId}/init`, { method: 'POST' });
      this._terminal?.appendOutput?.('Git repository initialised.');
      await this.refresh();
    } catch (err) { this._toast(`Init failed: ${err.message}`); }
  }

  async _bulk(op, pathsOrAll) {
    try {
      const body = { paths: pathsOrAll };
      await this._api(`/git/${this._projectId}/${op}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await this.refresh();
    } catch (err) { this._toast(`${op} failed: ${err.message}`); }
  }

  async _doCommit(message) {
    const msg = String(message || '').trim();
    if (!msg) { this._toast('Write a commit message first.'); return; }
    if (!this._status?.hasStaged) { this._toast('Nothing staged — use "Stage all + Commit" or stage files first.'); return; }
    try {
      const r = await this._api(`/git/${this._projectId}/commit`, {
        method: 'POST',
        body: JSON.stringify({ message: msg }),
      });
      this._terminal?.appendOutput?.(`Committed ${r.commit || ''}: ${r.summary?.changes ?? '?'} changes.`);
      await this.refresh();
    } catch (err) { this._toast(`Commit failed: ${err.message}`); }
  }

  async _doStageAllAndCommit(message) {
    const msg = String(message || '').trim();
    if (!msg) { this._toast('Write a commit message first.'); return; }
    try {
      await this._api(`/git/${this._projectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ paths: 'all' }),
      });
      await this._doCommit(msg);
    } catch (err) { this._toast(`Stage failed: ${err.message}`); }
  }

  async _doPush() {
    this._terminal?.appendOutput?.('Pushing…');
    try {
      await this._api(`/git/${this._projectId}/push`, { method: 'POST', body: JSON.stringify({}) });
      this._terminal?.appendOutput?.('Pushed.');
      await this.refresh();
    } catch (err) { this._toast(`Push failed: ${err.message}`); }
  }

  async _doPull() {
    this._terminal?.appendOutput?.('Pulling…');
    try {
      await this._api(`/git/${this._projectId}/pull`, { method: 'POST', body: JSON.stringify({}) });
      this._terminal?.appendOutput?.('Pulled.');
      await this.refresh();
    } catch (err) { this._toast(`Pull failed: ${err.message}`); }
  }

  async _viewDiff(fileEntry, staged) {
    try {
      // "before" = what's in HEAD (or the index for staged diffs).
      // "after"  = working-tree version on disk.
      const ref = staged ? 'HEAD' : 'HEAD';
      const before = await this._api(`/git/${this._projectId}/show?path=${encodeURIComponent(fileEntry.path)}&ref=${ref}`)
        .then(r => r.content || '')
        .catch(() => '');
      let after = '';
      try {
        const r = await this._api(`/workspace/${this._projectId}/file?path=${encodeURIComponent(fileEntry.path)}`);
        after = r?.content || '';
      } catch { /* file might be deleted or binary */ }
      this._editor.showDiff(fileEntry.path, before, after, { readOnly: true });
    } catch (err) { this._toast(`Diff failed: ${err.message}`); }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _shortStatus(f) {
    if (f.untracked) return 'U';
    const i = f.index !== ' ' ? f.index : '';
    const w = f.working !== ' ' ? f.working : '';
    return (i + w) || '•';
  }

  _relativeTime(isoStr) {
    try {
      const d = new Date(isoStr);
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return 'just now';
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d ago`;
      return d.toLocaleDateString();
    } catch { return ''; }
  }

  _toast(msg) {
    if (this._terminal?.appendOutput) this._terminal.appendOutput(msg);
    else console.warn('[git]', msg);
  }

  _div(cls) { const el = document.createElement('div'); if (cls) el.className = cls; return el; }
  _btn(text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'git-btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  _injectStyles() {
    if (document.getElementById('git-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'git-panel-styles';
    style.textContent = `
      .git-panel { display: flex; flex-direction: column; height: 100%; color: #cfcfcf; font-size: 12px; overflow-y: auto; }
      .git-panel .git-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #2d2d2d; }
      .git-panel .git-branch-pill { padding: 2px 10px; background: #0e639c; color: #fff; border-radius: 11px; font-weight: 600; font-size: 12px; }
      .git-panel .git-sync-row { display: flex; align-items: center; gap: 6px; margin-left: auto; }
      .git-panel .git-ab { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #9ad; margin-right: 4px; }
      .git-panel .git-btn { padding: 4px 10px; background: #3c3c3c; color: #e6e6e6; border: 1px solid #5a5a5a; border-radius: 3px; cursor: pointer; font-size: 12px; }
      .git-panel .git-btn:hover:not(:disabled) { background: #4a4a4a; }
      .git-panel .git-btn:disabled { opacity: 0.5; cursor: default; }
      .git-panel .git-btn-sm { padding: 2px 8px; font-size: 11px; }
      .git-panel .git-btn-xs { padding: 1px 6px; font-size: 11px; }
      .git-panel .git-btn-primary { background: #0e639c; border-color: #0e639c; color: #fff; }
      .git-panel .git-btn-primary:hover:not(:disabled) { background: #1178bc; }
      .git-panel .git-status-msg { padding: 8px 10px; color: #8a8a8a; }
      .git-panel .git-clean { padding: 8px 10px; color: #6a9955; }
      .git-panel .git-changes { padding: 4px 0; }
      .git-panel .git-group-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px 4px; text-transform: uppercase; font-size: 11px; color: #bbb; letter-spacing: 0.04em; }
      .git-panel .git-count { background: #555; color: #eee; padding: 0 6px; border-radius: 9px; font-size: 10px; }
      .git-panel .git-group-actions { margin-left: auto; display: flex; gap: 4px; }
      .git-panel .git-file-row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 3px; }
      .git-panel .git-file-row:hover { background: #2a2d2e; }
      .git-panel .git-file-label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer; }
      .git-panel .git-badge { display: inline-block; min-width: 16px; text-align: center; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #dcdcaa; background: #3a3a3a; padding: 0 4px; border-radius: 3px; }
      .git-panel .git-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .git-panel .git-file-actions { display: flex; gap: 3px; }
      .git-panel .git-commit-box { padding: 10px; border-top: 1px solid #2d2d2d; display: flex; flex-direction: column; gap: 6px; }
      .git-panel .git-commit-input { background: #1e1e1e; color: #eee; border: 1px solid #3c3c3c; padding: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; resize: vertical; }
      .git-panel .git-commit-btn-row { display: flex; gap: 6px; }
      .git-panel .git-log { padding: 8px 10px; border-top: 1px solid #2d2d2d; }
      .git-panel .git-log-header { font-size: 11px; text-transform: uppercase; color: #bbb; letter-spacing: 0.04em; margin-bottom: 6px; }
      .git-panel .git-log-row { padding: 4px 0; border-bottom: 1px solid #252525; }
      .git-panel .git-log-top { display: flex; gap: 8px; align-items: baseline; }
      .git-panel .git-log-hash { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #ce9178; }
      .git-panel .git-log-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .git-panel .git-log-sub { font-size: 10px; color: #888; margin-top: 1px; }
      .sidebar-tabs { display: flex; background: #252526; border-bottom: 1px solid #2d2d2d; }
      .sidebar-tab { flex: 1; padding: 6px 10px; text-align: center; cursor: pointer; color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .sidebar-tab.active { color: #fff; border-bottom: 2px solid #0e639c; background: #1e1e1e; }
      .sidebar-tab:hover:not(.active) { color: #ccc; }
      .sidebar-pane { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
      .sidebar-pane.hidden { display: none; }
    `;
    document.head.appendChild(style);
  }
}
