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

// ── OAuth/identity migrations on users table (idempotent) ───────────
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN display_name TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN auth_provider TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN provider_subject TEXT"); } catch { /* already exists */ }

try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_provider ON users(auth_provider, provider_subject)"); } catch { /* ok */ }
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email)"); } catch { /* ok */ }

// ── Mail accounts (Phase 2 — read-only mail + calendar) ─────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_accounts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          TEXT    NOT NULL CHECK(provider IN ('microsoft','google')),
    email             TEXT    NOT NULL,
    display_name      TEXT,
    access_token_enc  BLOB    NOT NULL,
    refresh_token_enc BLOB,
    expires_at        INTEGER,
    scopes            TEXT,
    provider_subject  TEXT,
    status            TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','needs_reconnect','error')),
    last_error        TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, provider, email)
  );
  CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id);
`);

// ── Mail action approvals (Phase 3 — write operations require approval) ─
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_action_approvals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    action_type     TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    preview         TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','executed','expired','failed')),
    result          TEXT,
    error           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT,
    expires_at      TEXT    NOT NULL DEFAULT (datetime('now','+15 minutes'))
  );
  CREATE INDEX IF NOT EXISTS idx_mail_approvals_user ON mail_action_approvals(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_mail_approvals_conv ON mail_action_approvals(conversation_id);
`);

// ── Allowed-emails allowlist ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS allowed_emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    role       TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    is_domain  INTEGER NOT NULL DEFAULT 0 CHECK(is_domain IN (0,1)),
    added_by   INTEGER REFERENCES users(id),
    note       TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  // Users
  insertUser: db.prepare('INSERT INTO users (username, password) VALUES (?, ?)'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT id, username, email, display_name, role, auth_provider, created_at FROM users WHERE id = ?'),

  // OAuth / identity
  getUserByProvider: db.prepare(
    'SELECT * FROM users WHERE auth_provider = ? AND provider_subject = ?'
  ),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  // password column is NOT NULL — pass '' for OAuth users; username gets the email
  insertOAuthUser: db.prepare(
    `INSERT INTO users (username, password, email, display_name, role, auth_provider, provider_subject)
     VALUES (?, '', ?, ?, ?, ?, ?)`
  ),
  updateUserProvider: db.prepare(
    `UPDATE users
        SET auth_provider    = ?,
            provider_subject = ?,
            display_name     = COALESCE(?, display_name)
      WHERE id = ?`
  ),
  updateUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  updateUserEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
  listUsers: db.prepare(
    `SELECT id, username, email, display_name, role, auth_provider, created_at
       FROM users
       ORDER BY created_at DESC`
  ),

  // Allowed emails / allowlist
  findAllowedExact: db.prepare(
    "SELECT * FROM allowed_emails WHERE email = ? COLLATE NOCASE AND is_domain = 0"
  ),
  findAllowedDomainAll: db.prepare(
    'SELECT * FROM allowed_emails WHERE is_domain = 1'
  ),
  listAllowedEmails: db.prepare(
    `SELECT a.id, a.email, a.role, a.is_domain, a.note, a.created_at,
            u.username AS added_by_username
       FROM allowed_emails a
       LEFT JOIN users u ON u.id = a.added_by
      ORDER BY a.created_at DESC`
  ),
  getAllowedById: db.prepare('SELECT * FROM allowed_emails WHERE id = ?'),
  insertAllowedEmail: db.prepare(
    'INSERT INTO allowed_emails (email, role, is_domain, added_by, note) VALUES (?, ?, ?, ?, ?)'
  ),
  deleteAllowedEmail: db.prepare('DELETE FROM allowed_emails WHERE id = ?'),
  countAllowedEmails: db.prepare('SELECT COUNT(*) AS count FROM allowed_emails'),
  countAllowedAdmins: db.prepare(
    "SELECT COUNT(*) AS count FROM allowed_emails WHERE role = 'admin'"
  ),

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

  // Mail accounts — NEVER expose token blobs in list responses
  listMailAccounts: db.prepare(
    `SELECT id, provider, email, display_name, status, created_at
       FROM mail_accounts
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ),
  getMailAccount: db.prepare(
    'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?'
  ),
  getMailAccountByIdRaw: db.prepare(
    'SELECT * FROM mail_accounts WHERE id = ?'
  ),
  insertMailAccount: db.prepare(
    `INSERT INTO mail_accounts
       (user_id, provider, email, display_name, access_token_enc, refresh_token_enc,
        expires_at, scopes, provider_subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  updateMailAccountTokens: db.prepare(
    `UPDATE mail_accounts
        SET access_token_enc  = ?,
            refresh_token_enc = ?,
            expires_at        = ?,
            status            = 'active',
            last_error        = NULL,
            updated_at        = datetime('now')
      WHERE id = ?`
  ),
  updateMailAccountStatus: db.prepare(
    `UPDATE mail_accounts
        SET status     = ?,
            last_error = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ),
  deleteMailAccount: db.prepare(
    'DELETE FROM mail_accounts WHERE id = ? AND user_id = ?'
  ),
  findMailAccountByEmail: db.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? AND provider = ? AND email = ?'
  ),

  // Mail action approvals (Phase 3)
  insertApproval: db.prepare(
    `INSERT INTO mail_action_approvals
       (user_id, account_id, conversation_id, action_type, payload, preview)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getApproval: db.prepare(
    'SELECT * FROM mail_action_approvals WHERE id = ? AND user_id = ?'
  ),
  listPendingApprovals: db.prepare(
    `SELECT id, account_id, conversation_id, action_type, payload, preview,
            status, created_at, expires_at
       FROM mail_action_approvals
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at DESC`
  ),
  countPendingApprovalsByUser: db.prepare(
    "SELECT COUNT(*) AS count FROM mail_action_approvals WHERE user_id = ? AND status = 'pending'"
  ),
  updateApprovalStatus: db.prepare(
    `UPDATE mail_action_approvals
        SET status      = ?,
            result      = ?,
            error       = ?,
            resolved_at = datetime('now')
      WHERE id = ?`
  ),
  expireStaleApprovals: db.prepare(
    "UPDATE mail_action_approvals SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending' AND expires_at < datetime('now')"
  ),
  // Executed/failed approvals for a conversation, newest first — used by the
  // MailAgent continuation path so the model sees REAL message IDs it acted
  // on and doesn't hallucinate fake ones.
  listResolvedApprovalsByConv: db.prepare(
    `SELECT id, account_id, action_type, payload, preview, status, resolved_at
       FROM mail_action_approvals
      WHERE conversation_id = ? AND user_id = ?
        AND status IN ('executed','rejected','failed')
      ORDER BY resolved_at DESC
      LIMIT 30`
  ),

  // Containers
  insertContainer: db.prepare('INSERT INTO containers (project_id, user_id, image) VALUES (?, ?, ?)'),
  getContainer: db.prepare('SELECT * FROM containers WHERE id = ? AND user_id = ?'),
  listContainers: db.prepare('SELECT * FROM containers WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'),
  updateContainerStatus: db.prepare('UPDATE containers SET status = ?, docker_id = ? WHERE id = ?'),
  deleteContainer: db.prepare('DELETE FROM containers WHERE id = ? AND user_id = ?'),
  countUserContainers: db.prepare('SELECT COUNT(*) as count FROM containers WHERE user_id = ? AND status IN (\'created\',\'running\')'),
  cleanStaleContainers: db.prepare('DELETE FROM containers WHERE user_id = ? AND docker_id IS NULL'),
};

// ── Bootstrap: seed admin allowlist entry on first boot ─────────────
try {
  const row = stmts.countAllowedEmails.get();
  if (row && row.count === 0 && process.env.BOOTSTRAP_ADMIN_EMAIL) {
    stmts.insertAllowedEmail.run(
      process.env.BOOTSTRAP_ADMIN_EMAIL,
      'admin',
      0,
      null,
      'bootstrap',
    );
    console.log(`[auth] bootstrapped admin allowlist: ${process.env.BOOTSTRAP_ADMIN_EMAIL}`);
  }
} catch (err) {
  console.warn('[auth] bootstrap admin allowlist failed:', err.message);
}

/** Convenience: run the expiry sweep and return rows changed. */
export function expireStaleApprovals() {
  try {
    const info = stmts.expireStaleApprovals.run();
    return info?.changes ?? 0;
  } catch {
    return 0;
  }
}

export { db, stmts };
