import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'gsd.db');

// Ensure the data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance & safety pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema (idempotent)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL DEFAULT 'New Chat',
    agent_id   TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user
    ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK(role IN ('user','assistant')),
    agent_id        TEXT,
    content         TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conversation_id, id ASC);

  CREATE TABLE IF NOT EXISTS assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    type            TEXT    NOT NULL CHECK(type IN ('video','image','slide','code')),
    filename        TEXT    NOT NULL,
    original_name   TEXT,
    title           TEXT,
    size_bytes      INTEGER,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assets_user
    ON assets(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user
    ON projects(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS containers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    docker_id  TEXT,
    image      TEXT    NOT NULL DEFAULT 'gsd-node:20',
    status     TEXT    NOT NULL DEFAULT 'created' CHECK(status IN ('created','running','stopped','removed')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_containers_user
    ON containers(user_id);
`);

// Migration: add env_vars column if missing
try { db.exec("ALTER TABLE projects ADD COLUMN env_vars TEXT DEFAULT '{}'"); } catch { /* already exists */ }

// Prepared statements
const stmts = {
  // Users
  insertUser: db.prepare('INSERT INTO users (username, password) VALUES (?, ?)'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),

  // Conversations
  listConversations: db.prepare(
    'SELECT id, title, agent_id, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
  ),
  getConversation: db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?'),
  insertConversation: db.prepare(
    'INSERT INTO conversations (user_id, title, agent_id) VALUES (?, ?, ?)'
  ),
  updateConversationTitle: db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?'),
  touchConversation: db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?'),

  // Messages
  listMessages: db.prepare(
    'SELECT id, role, agent_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (conversation_id, role, agent_id, content) VALUES (?, ?, ?, ?)'
  ),

  // Assets
  listAssets: db.prepare(
    'SELECT id, type, filename, original_name, title, size_bytes, created_at FROM assets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ),
  getAsset: db.prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?'),
  insertAsset: db.prepare(
    'INSERT INTO assets (user_id, conversation_id, type, filename, original_name, title, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  deleteAsset: db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?'),

  // Projects
  insertProject: db.prepare('INSERT INTO projects (user_id, name) VALUES (?, ?)'),
  getProject: db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?'),
  listProjects: db.prepare('SELECT id, name, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC'),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?'),

  getProjectEnv: db.prepare('SELECT env_vars FROM projects WHERE id = ? AND user_id = ?'),
  updateProjectEnv: db.prepare('UPDATE projects SET env_vars = ? WHERE id = ? AND user_id = ?'),

  // Containers
  insertContainer: db.prepare('INSERT INTO containers (project_id, user_id, image) VALUES (?, ?, ?)'),
  getContainer: db.prepare('SELECT * FROM containers WHERE id = ? AND user_id = ?'),
  listContainers: db.prepare('SELECT * FROM containers WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'),
  updateContainerStatus: db.prepare('UPDATE containers SET status = ?, docker_id = ? WHERE id = ?'),
  deleteContainer: db.prepare('DELETE FROM containers WHERE id = ? AND user_id = ?'),
  countUserContainers: db.prepare('SELECT COUNT(*) as count FROM containers WHERE user_id = ? AND status IN (\'created\',\'running\')'),
  cleanStaleContainers: db.prepare('DELETE FROM containers WHERE user_id = ? AND docker_id IS NULL'),
};

export { db, stmts };
