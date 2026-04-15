import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '7d';

// Resolve secret — use env var or generate an ephemeral one
let jwtSecret = config.jwtSecret;
if (!jwtSecret) {
  jwtSecret = randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set — using random secret. Tokens will not survive server restart.');
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(userId, username) {
  return jwt.sign({ sub: userId, username }, jwtSecret, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}

/** Express middleware — attaches req.user or responds 401. */
export function expressAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const payload = verifyToken(header.slice(7));
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Socket.IO middleware — attaches socket.user or rejects connection. */
export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const payload = verifyToken(token);
    socket.user = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return next(new Error('Invalid or expired token'));
  }
}
