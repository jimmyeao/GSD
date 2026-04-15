import { Router } from 'express';
import { stmts } from '../db.js';
import { hashPassword, verifyPassword, signToken } from '../auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{2,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-32 alphanumeric characters or underscores' });
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  // Check uniqueness
  const existing = stmts.getUserByUsername.get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const hash = await hashPassword(password);
  const result = stmts.insertUser.run(username, hash);
  const token = signToken(result.lastInsertRowid, username);

  res.status(201).json({
    token,
    user: { id: result.lastInsertRowid, username },
  });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = stmts.getUserByUsername.get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken(user.id, user.username);
  res.json({
    token,
    user: { id: user.id, username: user.username },
  });
});

export default router;
