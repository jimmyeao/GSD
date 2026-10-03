import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, stmts } from '../src/db.js';
import { getRelevantFacts, getMemoryContext } from '../src/memory.js';

// These tests write to the real db.js singleton (there's no test-mode DB
// override yet) — scoped to one disposable test user, cleaned up in `after`
// via ON DELETE CASCADE.
let userId;

before(() => {
  const result = stmts.insertUser.run(`__memory_test_user_${Date.now()}__`, '');
  userId = result.lastInsertRowid;
});

after(() => {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

describe('memory_facts supersede logic', () => {
  it('keeps exactly one active row per (user, entity, attribute), superseding on value change', () => {
    stmts.insertMemoryFact.run(userId, 'Priya', 'role', 'manager', null, 0.8);
    let active = stmts.factsForEntity.all(userId, 'Priya');
    assert.equal(active.length, 1);
    assert.equal(active[0].value, 'manager');

    const existing = stmts.getActiveFact.get(userId, 'Priya', 'role');
    stmts.supersedeFact.run(existing.id);
    stmts.insertMemoryFact.run(userId, 'Priya', 'role', 'skip-level manager', null, 0.8);

    active = stmts.factsForEntity.all(userId, 'Priya');
    assert.equal(active.length, 1);
    assert.equal(active[0].value, 'skip-level manager');

    const all = db.prepare(
      "SELECT status FROM memory_facts WHERE user_id = ? AND entity = 'Priya' AND attribute = 'role'"
    ).all(userId);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.status).sort(), ['active', 'superseded']);
  });

  it('rejects a second concurrent active row for the same (user, entity, attribute) at the DB level', () => {
    stmts.insertMemoryFact.run(userId, 'Bob', 'team', 'platform', null, 0.7);
    assert.throws(() => {
      stmts.insertMemoryFact.run(userId, 'Bob', 'team', 'infra', null, 0.7);
    });
  });
});

describe('getRelevantFacts / getMemoryContext', () => {
  it('finds a fact by case-insensitive substring match on the entity name', () => {
    stmts.insertMemoryFact.run(userId, 'Acme Project', 'deadline', 'end of Q3', null, 0.9);

    const facts = getRelevantFacts(userId, 'any update on the acme project timeline?');
    assert.ok(facts.some((f) => f.entity === 'Acme Project' && f.value === 'end of Q3'));
  });

  it('returns no facts when the message mentions no known entity', () => {
    const facts = getRelevantFacts(userId, 'what is the weather like today?');
    assert.equal(facts.length, 0);
  });

  it('matches a multi-word entity when only one word is mentioned', () => {
    const facts = getRelevantFacts(userId, 'any news on acme?');
    assert.ok(facts.some((f) => f.entity === 'Acme Project'));
  });

  it('formats matched facts as a reference-only system message', () => {
    const context = getMemoryContext(userId, 'tell me about the acme project');
    assert.match(context, /reference information/i);
    assert.match(context, /Acme Project/);
  });

  it('returns an empty string when nothing matches', () => {
    const context = getMemoryContext(userId, 'unrelated message with no entities');
    assert.equal(context, '');
  });
});
