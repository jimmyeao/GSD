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
      this._switchTab(filePath);
      return;
    }
    const lang = langFromPath(filePath);
    const model = window.monaco.editor.createModel(content, lang);
    this._tabs.set(filePath, { model, viewState: null });
    this._renderTabs();
    this._switchTab(filePath);
  }

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

  /** Destroy editor. */
  dispose() {
    if (this._editor) { this._editor.dispose(); this._editor = null; }
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
  }

  _renderTabs() {
    this._tabBar.innerHTML = '';
    for (const [path] of this._tabs) {
      const tab = document.createElement('div');
      tab.className = 'editor-tab' + (path === this._activePath ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'editor-tab-name';
      name.textContent = path.split('/').pop();
      name.title = path;
      tab.appendChild(name);

      const close = document.createElement('span');
      close.className = 'editor-tab-close';
      close.textContent = '\u00d7';
      close.addEventListener('click', e => { e.stopPropagation(); this.closeFile(path); });
      tab.appendChild(close);

      tab.addEventListener('click', () => this._switchTab(path));
      this._tabBar.appendChild(tab);
    }
  }
}
