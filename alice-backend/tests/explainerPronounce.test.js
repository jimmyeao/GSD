import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRespelling, cleanLexicon, applyPronunciations, loadLexicon } from '../src/agents/explainer/pronounce.js';
import { normalizePlan } from '../src/agents/explainer/planner.js';

describe('pronunciations', () => {
  it('joins hyphenated hints into one TTS-friendly word', () => {
    assert.equal(normalizeRespelling('thee-ah-cast'), 'Theeahcast');
    assert.equal(normalizeRespelling('"ack mee"'), 'Ackmee');
    assert.equal(normalizeRespelling('<script>'), '');
  });
  it('replaces whole words only, case-insensitively, keeping punctuation', () => {
    const lex = { TheiaCast: 'Theeahcast' };
    assert.equal(applyPronunciations('Meet theiacast, TheiaCast’s app — not TheiaCastle.', lex), 'Meet Theeahcast, Theeahcast’s app — not TheiaCastle.');
  });
  it('drops junk entries', () => {
    assert.deepEqual(cleanLexicon({ _comment: 'x', Good: 'goo-d', Bad: 5, '': 'x' }), { Good: 'Good' });
  });
  it('ships TheiaCast in the shared lexicon', () => {
    assert.equal(loadLexicon().TheiaCast, 'Theeahcast');
  });
  it('plans keep client pronunciations', () => {
    const p = normalizePlan({ pronunciations: { Acme: 'ack-mee' }, scenes: [{ type: 'narrated', speech: 'Hi Acme.' }] }, { presenter: false, maxPresenterScenes: 0 });
    assert.deepEqual(p.pronunciations, { Acme: 'Ackmee' });
  });
});
