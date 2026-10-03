import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, stmts } from '../src/db.js';
import {
  getFreshContact, upsertContact, getFreshThreadsMatching, upsertThread,
  getContactContext, invalidateMailCache,
} from '../src/mail/cache.js';

// Writes to the real db.js singleton, scoped to one disposable user/account,
// cleaned up in `after` via ON DELETE CASCADE.
let userId;
let accountId;

before(() => {
  const u = stmts.insertUser.run(`__mail_cache_test_user_${Date.now()}__`, '');
  userId = u.lastInsertRowid;
  const a = stmts.insertMailAccount.run(
    userId, 'google', 'test@example.com', 'Test Account', Buffer.from('x'), null, null, null, null
  );
  accountId = a.lastInsertRowid;
});

after(() => {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

describe('mail cache freshness', () => {
  it('treats a just-written row as fresh (regression: sqlite UTC timestamp vs. local-time Date.parse)', () => {
    upsertContact(accountId, { email: 'priya@acme.com', displayName: 'Priya Sharma' });
    assert.ok(getFreshContact(accountId, 'priya@acme.com'), 'expected a just-cached contact to read back as fresh');
  });
});

describe('mail cache token matching', () => {
  it('matches a contact by first-name mention, not just the full display name (regression)', () => {
    upsertContact(accountId, {
      email: 'priya@acme.com', displayName: 'Priya Sharma',
      lastMessageId: 'm1', lastMessageDate: '2026-07-20T10:00:00Z', lastSubject: 'Q3 plan',
    });
    const context = getContactContext([accountId], 'any update from priya?');
    assert.match(context, /Priya Sharma/);
  });

  it('matches a cached thread by first-name mention against its participants', () => {
    upsertThread(accountId, {
      threadId: 't1', subject: 'Q3 plan',
      participants: [{ name: 'Priya Sharma', email: 'priya@acme.com' }],
      messageSummaries: [{ id: 'm1', from: 'priya@acme.com', subject: 'Q3 plan', snippet: 'plan', date: '2026-07-20T10:00:00Z' }],
      lastMessageDate: '2026-07-20T10:00:00Z',
    });
    const hits = getFreshThreadsMatching(accountId, 'any update from priya?');
    assert.ok(hits.some((m) => m.id === 'm1'));
  });

  it('finds nothing for an unrelated query', () => {
    const context = getContactContext([accountId], 'what time is the standup tomorrow?');
    assert.equal(context, '');
  });
});

describe('mail cache invalidation', () => {
  it('wipes both contact and thread rows for the account', () => {
    upsertContact(accountId, { email: 'bob@acme.com', displayName: 'Bob' });
    upsertThread(accountId, { threadId: 't2', subject: 'hi', participants: [], messageSummaries: [] });

    invalidateMailCache(accountId);

    assert.equal(getFreshContact(accountId, 'bob@acme.com'), null);
    assert.deepEqual(getFreshThreadsMatching(accountId, 'hi'), []);
  });
});
