/**
 * Monaco Editor wrapper with multi-tab support.
 * Loads Monaco from CDN using AMD loader.
 */

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';

const EXT_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', json: 'json', html: 'html', css: 'css',
  md: 'markdown', xml: 'xml', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', sql: 'sql', go: 'go', rs: 'rust',
  java: 'java', c: 'c', cpp: 'cpp', h: 'c', rb: 'ruby',
  php: 'php', swift: 'swift', toml: 'ini',
  lua: 'lua',
};

function langFromPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return EXT_LANG[ext] || 'plaintext';
}

let _monacoReady = null;

function loadMonaco() {
  if (_monacoReady) return _monacoReady;
  _monacoReady = new Promise((resolve, reject) => {
    if (window.monaco) { resolve(window.monaco); return; }

    const doLoad = () => {
      window.require.config({ paths: { vs: MONACO_CDN } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };

    // AMD loader already in page from index.html — just use it
    if (typeof window.require !== 'undefined' && window.require.config) {
      doLoad();
    } else {
      // Fallback: load the loader script
      const script = document.createElement('script');
      script.src = `${MONACO_CDN}/loader.js`;
      script.onload = doLoad;
      script.onerror = () => reject(new Error('Failed to load Monaco loader'));
      document.head.appendChild(script);
    }
  });
  return _monacoReady;
}

export class Editor {
  /** @param {HTMLElement} containerEl - div to mount Monaco into */
  constructor(containerEl) {
    this._root = containerEl;
    this._editor = null;
    this._tabs = new Map(); // path → { model, viewState }
    this._activePath = null;
    this._tabBar = null;
    this._editorDiv = null;
    this._onSave = null;
    this._onTabChange = null;
    this._onDirtyChange = null;
  }

  /** Initialize Monaco (load from CDN, create editor instance). */
  async init() {
    const monaco = await loadMonaco();

    this._tabBar = document.createElement('div');
    this._tabBar.className = 'editor-tab-bar';
    this._root.appendChild(this._tabBar);

    this._editorDiv = document.createElement('div');
    this._editorDiv.className = 'editor-container';
    this._editorDiv.style.flex = '1';
    this._editorDiv.style.minHeight = '0';
    this._root.appendChild(this._editorDiv);

    this._root.style.display = 'flex';
    this._root.style.flexDirection = 'column';

    this._editor = monaco.editor.create(this._editorDiv, {
      theme: 'vs-dark',
      fontSize: 14,
      minimap: { enabled: true },
      automaticLayout: true,
      readOnly: false,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
    });

    // Ctrl+S / Cmd+S
    this._editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (this._onSave && this._activePath) {
        this._onSave({ path: this._activePath, content: this.getContent() });
      }
    });
  }

  /**
   * Open a file in a new tab (or switch to existing tab).
   * @param {string} filePath - relative path like 'src/index.js'
   * @param {string} content - file content
   */
  openFile(filePath, content) {
    if (this._tabs.has(filePath)) {
      // Reload content if a later disk/agent update brought something new;
      // keeps dirty state clean when the file was written by CoderAgent.
      const entry = this._tabs.get(filePath);
      if (entry.model.getValue() !== content) {
        // Set savedContent BEFORE setValue so the onDidChangeContent handler
        // compares the new value against the new saved content (clean, not dirty).
        entry.savedContent = content;
        entry.dirty = false;
        entry.model.setValue(content);
        this._renderTabs();
        if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
      }
      this._switchTab(filePath);
      return;
    }
    const lang = langFromPath(filePath);
    const model = window.monaco.editor.createModel(content, lang);
    const entry = { model, viewState: null, savedContent: content, dirty: false };
    // Track dirty by comparing against savedContent on every change. Cheap
    // because Monaco only fires change events on real edits.
    model.onDidChangeContent(() => {
      const isDirty = model.getValue() !== entry.savedContent;
      if (isDirty !== entry.dirty) {
        entry.dirty = isDirty;
        this._renderTabs();
        if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
      }
    });
    this._tabs.set(filePath, entry);
    this._renderTabs();
    this._switchTab(filePath);
    if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
  }

  /** Returns true if the active file has unsaved changes. */
  isActiveDirty() {
    if (!this._activePath) return false;
    const entry = this._tabs.get(this._activePath);
    return !!(entry && entry.dirty);
  }

  /** Returns array of paths with unsaved changes. */
  _dirtyPaths() {
    const out = [];
    for (const [path, entry] of this._tabs) if (entry.dirty) out.push(path);
    return out;
  }

  /** Mark a tab clean — call after a successful save of that path. */
  markClean(filePath) {
    const entry = this._tabs.get(filePath);
    if (!entry) return;
    entry.savedContent = entry.model.getValue();
    if (entry.dirty) {
      entry.dirty = false;
      this._renderTabs();
      if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
    }
  }

  /** Trigger the save callback for the active tab (same path as Ctrl+S). */
  saveActive() {
    if (this._onSave && this._activePath) {
      this._onSave({ path: this._activePath, content: this.getContent() });
    }
  }

  /** Register a dirty-state change callback: (dirtyPaths: string[]) => void */
  onDirtyChange(callback) { this._onDirtyChange = callback; }

  /** Close a tab. */
  closeFile(filePath) {
    const entry = this._tabs.get(filePath);
    if (!entry) return;
    entry.model.dispose();
    this._tabs.delete(filePath);

    if (this._activePath === filePath) {
      const remaining = [...this._tabs.keys()];
      if (remaining.length) {
        this._switchTab(remaining[remaining.length - 1]);
      } else {
        this._activePath = null;
        this._editor.setModel(null);
      }
    }
    this._renderTabs();
    if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
  }

  /** Get content of active file. */
  getContent() {
    return this._editor ? this._editor.getValue() : '';
  }

  /** Get path of active file. */
  getActivePath() {
    return this._activePath;
  }

  /** Register a save callback (Ctrl+S). */
  onSave(callback) { this._onSave = callback; }

  /** Register a tab change callback. */
  onTabChange(callback) { this._onTabChange = callback; }

  /**
   * Open a side-by-side diff view for `filePath`, comparing `original`
   * (e.g. HEAD version) with `modified` (e.g. working-tree version).
   * Hides the regular editor + tab bar until closeDiff() is called.
   */
  showDiff(filePath, original, modified, { readOnly = true } = {}) {
    const monaco = window.monaco;
    if (!monaco) return;
    if (!this._diffDiv) {
      this._diffDiv = document.createElement('div');
      this._diffDiv.className = 'editor-diff';
      this._diffDiv.style.position = 'absolute';
      this._diffDiv.style.inset = '0';
      this._diffDiv.style.display = 'none';
      this._diffDiv.style.flexDirection = 'column';
      this._diffDiv.style.background = '#1e1e1e';
      this._diffDiv.style.zIndex = '5';
      const header = document.createElement('div');
      header.className = 'editor-diff-header';
      header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;background:#252526;border-bottom:1px solid #333;color:#ddd;font-size:12px;';
      this._diffHeaderTitle = document.createElement('span');
      this._diffHeaderTitle.style.flex = '1';
      header.appendChild(this._diffHeaderTitle);
      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close diff';
      closeBtn.style.cssText = 'padding:2px 8px;background:#0e639c;color:#fff;border:0;border-radius:3px;cursor:pointer;font-size:12px;';
      closeBtn.addEventListener('click', () => this.closeDiff());
      header.appendChild(closeBtn);
      const body = document.createElement('div');
      body.className = 'editor-diff-body';
      body.style.cssText = 'flex:1;min-height:0;';
      this._diffDiv.append(header, body);
      this._root.appendChild(this._diffDiv);
      this._root.style.position = 'relative';
      this._diffEditor = monaco.editor.createDiffEditor(body, {
        theme: 'vs-dark',
        fontSize: 14,
        readOnly,
        automaticLayout: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
      });
    }
    const lang = langFromPath(filePath);
    const origModel = monaco.editor.createModel(original || '', lang);
    const modModel = monaco.editor.createModel(modified || '', lang);
    // Dispose previous models to avoid leaks across multiple diff opens.
    const old = this._diffEditor.getModel();
    if (old) { try { old.original?.dispose(); old.modified?.dispose(); } catch { /* ignore */ } }
    this._diffEditor.setModel({ original: origModel, modified: modModel });
    this._diffHeaderTitle.textContent = `Diff: ${filePath}`;
    this._diffDiv.style.display = 'flex';
    // Hide the regular editor + tabs while diff is up.
    if (this._tabBar) this._tabBar.style.display = 'none';
    if (this._editorDiv) this._editorDiv.style.display = 'none';
  }

  /** Close the diff overlay and return to regular editor view. */
  closeDiff() {
    if (!this._diffDiv) return;
    this._diffDiv.style.display = 'none';
    if (this._tabBar) this._tabBar.style.display = '';
    if (this._editorDiv) this._editorDiv.style.display = '';
  }

  /** Destroy editor. */
  dispose() {
    if (this._editor) { this._editor.dispose(); this._editor = null; }
    if (this._diffEditor) { try { this._diffEditor.dispose(); } catch { /* ignore */ } this._diffEditor = null; }
    this._tabs.forEach(entry => entry.model.dispose());
    this._tabs.clear();
    this._root.innerHTML = '';
  }

  // ── private ──────────────────────────────────────────────────────

  _switchTab(filePath) {
    // Save current viewState
    if (this._activePath && this._tabs.has(this._activePath)) {
      this._tabs.get(this._activePath).viewState = this._editor.saveViewState();
    }
    this._activePath = filePath;
    const entry = this._tabs.get(filePath);
    this._editor.setModel(entry.model);
    if (entry.viewState) this._editor.restoreViewState(entry.viewState);
    this._editor.focus();
    this._renderTabs();
    if (this._onTabChange) this._onTabChange(filePath);
    // Tab switch changes which file's dirty state the Save button represents.
    if (this._onDirtyChange) this._onDirtyChange(this._dirtyPaths());
  }

  _renderTabs() {
    this._tabBar.innerHTML = '';
    for (const [path, entry] of this._tabs) {
      const tab = document.createElement('div');
      tab.className = 'editor-tab' + (path === this._activePath ? ' active' : '') + (entry.dirty ? ' dirty' : '');

      const name = document.createElement('span');
      name.className = 'editor-tab-name';
      name.textContent = (entry.dirty ? '\u25CF ' : '') + path.split('/').pop();
      name.title = path + (entry.dirty ? '  (unsaved)' : '');
      tab.appendChild(name);

      const close = document.createElement('span');
      close.className = 'editor-tab-close';
      close.textContent = '\u00d7';
      close.title = entry.dirty ? 'Close (unsaved changes will be lost)' : 'Close';
      close.addEventListener('click', e => {
        e.stopPropagation();
        if (entry.dirty && !confirm(`"${path}" has unsaved changes. Close anyway?`)) return;
        this.closeFile(path);
      });
      tab.appendChild(close);

      tab.addEventListener('click', () => this._switchTab(path));
      this._tabBar.appendChild(tab);
    }
  }
}
