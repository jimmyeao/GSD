import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRespelling, cleanLexicon, applyPronunciations, loadLexicon, lexiconFor, presenterRespelling } from '../src/agents/explainer/pronounce.js';
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
    assert.deepEqual(cleanLexicon({ _comment: 'x', Good: 'goo-d', Bad: 5, '': 'x', Both: { tts: 'a', presenter: 'b' } }), { Good: 'goo-d', Both: { tts: 'a', presenter: 'b' } });
  });
  it('derives a different respelling per engine', () => {
    const lex = loadLexicon();
    assert.equal(lexiconFor(lex, 'tts').TheiaCast, 'Theeahcast');        // Kokoro: joined
    assert.equal(lexiconFor(lex, 'presenter').TheiaCast, 'Thee-ah-cast'); // LTX: hyphenated
    assert.equal(presenterRespelling('thee ah cast'), 'Thee-ah-cast');
    assert.deepEqual(lexiconFor({ X: { presenter: 'ex-ex' } }, 'tts'), {});
  });
  it('plans keep client pronunciations', () => {
    const p = normalizePlan({ pronunciations: { Acme: 'ack-mee' }, scenes: [{ type: 'narrated', speech: 'Hi Acme.' }] }, { presenter: false, maxPresenterScenes: 0 });
    assert.deepEqual(p.pronunciations, { Acme: 'ack-mee' });
  });
});
