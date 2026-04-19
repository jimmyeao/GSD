/**
 * AES-256-GCM encryption for mail OAuth tokens at rest.
 *
 * Key source: MAIL_TOKEN_KEY (base64, must decode to exactly 32 bytes).
 * Blob format: iv(12) || auth_tag(16) || ciphertext.
 *
 * NEVER log plaintext tokens or include them in error messages.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let _cachedKey = null;
let _cachedKeySource = null;

function getKey() {
  const raw = config.mailTokenKey;
  if (!raw) {
    throw new Error('MAIL_TOKEN_KEY is not configured');
  }
  if (_cachedKey && _cachedKeySource === raw) return _cachedKey;
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('MAIL_TOKEN_KEY is not valid base64');
  }
  if (decoded.length !== KEY_LEN) {
    throw new Error(`MAIL_TOKEN_KEY must decode to ${KEY_LEN} bytes (got ${decoded.length})`);
  }
  _cachedKey = decoded;
  _cachedKeySource = raw;
  return _cachedKey;
}

/** Check whether the key is present and well-formed without throwing. */
export function isTokenKeyValid() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a token string. Returns a Buffer suitable for storing in a BLOB column.
 * Throws if the key is missing/invalid.
 */
export function encryptToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptToken: plaintext must be a non-empty string');
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/**
 * Decrypt a BLOB produced by encryptToken(). Returns the original string.
 * Throws if the blob is malformed, the tag fails, or the key is missing.
 */
export function decryptToken(blob) {
  if (!Buffer.isBuffer(blob)) {
    blob = Buffer.from(blob);
  }
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptToken: blob too short');
  }
  const key = getKey();
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
