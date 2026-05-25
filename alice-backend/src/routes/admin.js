import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth, requireAdmin } from '../auth.js';

const router = Router();
router.use(expressAuth);
router.use(requireAdmin);

// Simple RFC-5322-ish email regex (good enough for a form-level check).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^@[^\s@]+\.[^\s@]+$/;

// ── Allowed emails ─────────────────────────────────────────────────

router.get('/allowed_emails', (_req, res) => {
  const entries = stmts.listAllowedEmails.all();
  // Normalise SQLite booleans (0/1) into JS booleans for the frontend.
  const shaped = entries.map((e) => ({
    id: e.id,
    email: e.email,
    role: e.role,
    is_domain: !!e.is_domain,
    note: e.note,
    created_at: e.created_at,
    added_by_username: e.added_by_username,
  }));
  res.json({ entries: shaped });
});

router.post('/allowed_emails', (req, res) => {
  const body = req.body || {};
  const emailRaw = typeof body.email === 'string' ? body.email.trim() : '';
  const roleRaw = typeof body.role === 'string' ? body.role.trim() : 'user';
  const isDomain = !!body.is_domain;
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  if (!emailRaw) return res.status(400).json({ error: 'email is required' });
  if (roleRaw !== 'user' && roleRaw !== 'admin') {
    return res.status(400).json({ error: 'role must be "user" or "admin"' });
  }

  // Normalise to lowercase for stable matching.
  const email = emailRaw.toLowerCase();

  if (isDomain) {
    if (!DOMAIN_RE.test(email)) {
      return res.status(400).json({ error: 'Domain entries must look like "@example.com"' });
    }
  } else if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const result = stmts.insertAllowedEmail.run(
      email,
      roleRaw,
      isDomain ? 1 : 0,
      req.user.id,
      note,
    );
    const row = stmts.getAllowedById.get(result.lastInsertRowid);
    res.status(201).json({
      entry: {
        id: row.id,
        email: row.email,
        role: row.role,
        is_domain: !!row.is_domain,
        note: row.note,
        created_at: row.created_at,
      },
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already in allowlist' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/allowed_emails/:id', (req, res) => {
  const row = stmts.getAllowedById.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entry not found' });

  // Refuse to delete the last admin entry to avoid locking the system out.
  if (row.role === 'admin' && !row.is_domain) {
    const { count } = stmts.countAllowedAdmins.get() || { count: 0 };
    if (count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin allowlist entry' });
    }
  }

  // Don't let a user delete their own allowlist entry.
  if (req.user.email && row.email && row.email.toLowerCase() === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot delete your own allowlist entry' });
  }

  stmts.deleteAllowedEmail.run(req.params.id);
  res.status(204).end();
});

// ── Users (read-only list for admin UI) ────────────────────────────

router.get('/users', (_req, res) => {
  const rows = stmts.listUsers.all();
  const users = rows.map((u) => ({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    auth_provider: u.auth_provider,
    created_at: u.created_at,
  }));
  res.json({ users });
});

export default router;
