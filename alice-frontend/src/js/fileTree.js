/**
 * File tree component — fetches and renders a workspace file tree.
 */

import { fetchJson } from './auth.js';

const FILE_ICONS = {
  js: 'JS', ts: 'TS', py: 'Py', json: '{}', html: '<>', css: '#',
  md: 'M', sh: '$', sql: 'Q', go: 'Go', rs: 'Rs', java: 'Jv',
  lua: 'Lu',
};

function iconForFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  return FILE_ICONS[ext] || '~';
}

export class FileTree {
  /**
   * @param {HTMLElement} containerEl - div to render tree into
   */
  constructor(containerEl) {
    this._root = containerEl;
    this._projectId = null;
    this._onSelect = null;
    this._onCreateFile = null;
    this._root.classList.add('file-tree');
    this._root.addEventListener('contextmenu', e => e.preventDefault());
  }

  /** Load and render the file tree for a project. */
  async load(projectId) {
    this._projectId = projectId;
    try {
      const data = await fetchJson(`/api/workspace/${encodeURIComponent(projectId)}/tree`);
      this._render((data && (data.tree || data)) || []);
    } catch (err) {
      this._root.innerHTML = `<div class="tree-error">${err.message}</div>`;
    }
  }

  /** Refresh current tree. */
  async refresh() {
    if (this._projectId) await this.load(this._projectId);
  }

  /** Register file select callback. */
  onSelect(callback) { this._onSelect = callback; }

  /** Register file create callback. */
  onCreateFile(callback) { this._onCreateFile = callback; }

  /** Register rename callback. */
  onRename(callback) { this._onRename = callback; }

  /** Register delete callback. */
  onDelete(callback) { this._onDelete = callback; }

  // ── private ──────────────────────────────────────────────────────

  _render(nodes) {
    this._root.innerHTML = '';

    // Root toolbar — always visible for creating files/folders at top level
    const bar = document.createElement('div');
    bar.className = 'tree-toolbar';
    const newFileBtn = document.createElement('button');
    newFileBtn.className = 'tree-toolbar-btn';
    newFileBtn.textContent = '+ File';
    newFileBtn.addEventListener('click', () => this._promptCreate('', 'file'));
    const newDirBtn = document.createElement('button');
    newDirBtn.className = 'tree-toolbar-btn';
    newDirBtn.textContent = '+ Folder';
    newDirBtn.addEventListener('click', () => this._promptCreate('', 'dir'));
    bar.append(newFileBtn, newDirBtn);
    this._root.appendChild(bar);

    if (!nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'Empty project — create a file to get started';
      this._root.appendChild(empty);
      return;
    }

    const ul = this._buildList(nodes, '');
    this._root.appendChild(ul);
  }

  _buildList(nodes, parentPath) {
    const ul = document.createElement('ul');
    ul.className = 'tree-list';

    // Sort: directories first, then alphabetical
    const sorted = [...nodes].sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    for (const node of sorted) {
      const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const li = document.createElement('li');
      li.className = 'tree-item';

      if (node.type === 'dir') {
        li.classList.add('tree-dir');
        const row = document.createElement('div');
        row.className = 'tree-row';

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = '>';
        row.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        row.appendChild(label);

        const addBtn = document.createElement('span');
        addBtn.className = 'tree-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'New file / folder';
        addBtn.addEventListener('click', e => {
          e.stopPropagation();
          this._showCreateMenu(fullPath, addBtn);
        });
        row.appendChild(addBtn);

        li.appendChild(row);

        if (node.children && node.children.length) {
          const childUl = this._buildList(node.children, fullPath);
          childUl.hidden = true;
          li.appendChild(childUl);
        }

        row.addEventListener('click', () => {
          const open = li.classList.toggle('open');
          const icon = row.querySelector('.tree-icon');
          icon.textContent = open ? 'v' : '>';
          const childList = li.querySelector(':scope > ul');
          if (childList) childList.hidden = !open;
        });
        li.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          this._showContextMenu(fullPath, node.name, 'dir', e);
        });
      } else {
        li.classList.add('tree-file');
        const row = document.createElement('div');
        row.className = 'tree-row';

        const icon = document.createElement('span');
        icon.className = 'tree-icon tree-file-icon';
        icon.textContent = iconForFile(node.name);
        row.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        row.appendChild(label);

        row.addEventListener('click', () => {
          // Remove previous active
          this._root.querySelectorAll('.tree-row.active').forEach(el => el.classList.remove('active'));
          row.classList.add('active');
          if (this._onSelect) this._onSelect({ path: fullPath, name: node.name });
        });
        li.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          this._showContextMenu(fullPath, node.name, 'file', e);
        });

        li.appendChild(row);
      }

      ul.appendChild(li);
    }
    return ul;
  }

  _showCreateMenu(dirPath, anchorEl) {
    // Remove any existing menu
    document.querySelectorAll('.tree-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'tree-context-menu';

    const newFile = document.createElement('div');
    newFile.className = 'tree-menu-item';
    newFile.textContent = 'New File';
    newFile.addEventListener('click', () => {
      menu.remove();
      this._promptCreate(dirPath, 'file');
    });

    const newFolder = document.createElement('div');
    newFolder.className = 'tree-menu-item';
    newFolder.textContent = 'New Folder';
    newFolder.addEventListener('click', () => {
      menu.remove();
      this._promptCreate(dirPath, 'dir');
    });

    menu.appendChild(newFile);
    menu.appendChild(newFolder);
    anchorEl.parentElement.appendChild(menu);

    const dismiss = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', dismiss); }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }

  _promptCreate(dirPath, type) {
    const name = prompt(`Enter ${type === 'dir' ? 'folder' : 'file'} name:`);
    if (!name || !name.trim()) return;
    const path = dirPath ? `${dirPath}/${name.trim()}` : name.trim();
    if (this._onCreateFile) this._onCreateFile({ path, type });
  }

  _showContextMenu(path, name, type, event) {
    document.querySelectorAll('.tree-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'tree-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    const rename = document.createElement('div');
    rename.className = 'tree-menu-item';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => {
      menu.remove();
      const newName = prompt('Rename to:', name);
      if (newName && newName.trim() && newName.trim() !== name) {
        if (this._onRename) this._onRename({ path, oldName: name, newName: newName.trim() });
      }
    });

    const del = document.createElement('div');
    del.className = 'tree-menu-item tree-menu-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      menu.remove();
      if (confirm(`Delete ${type === 'dir' ? 'folder' : 'file'} "${name}"?`)) {
        if (this._onDelete) this._onDelete({ path, type });
      }
    });

    menu.append(rename, del);

    if (type === 'dir') {
      const newFile = document.createElement('div');
      newFile.className = 'tree-menu-item';
      newFile.textContent = 'New File';
      newFile.addEventListener('click', () => { menu.remove(); this._promptCreate(path, 'file'); });
      const newDir = document.createElement('div');
      newDir.className = 'tree-menu-item';
      newDir.textContent = 'New Folder';
      newDir.addEventListener('click', () => { menu.remove(); this._promptCreate(path, 'dir'); });
      menu.prepend(newFile, newDir);
    }

    document.body.appendChild(menu);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', dismiss); }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }
}
