import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRespelling, cleanLexicon, applyPronunciations, loadLexicon, lexiconFor, presenterRespelling, mispronunciation } from '../src/agents/explainer/pronounce.js';
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
    assert.equal(lexiconFor(lex, 'tts').TheiaCast, 'Theea cast');        // Kokoro: verified by ear
    assert.equal(lexiconFor(lex, 'presenter').TheiaCast, 'Thee-ah-cast'); // LTX: hyphenated
    assert.equal(presenterRespelling('thee ah cast'), 'Thee-ah-cast');
    assert.deepEqual(lexiconFor({ X: { presenter: 'ex-ex' } }, 'tts'), {});
  });
  it('plans keep client pronunciations', () => {
    const p = normalizePlan({ pronunciations: { Acme: 'ack-mee' }, scenes: [{ type: 'narrated', speech: 'Hi Acme.' }] }, { presenter: false, maxPresenterScenes: 0 });
    assert.deepEqual(p.pronunciations, { Acme: 'ack-mee' });
  });
  it('verified shared respellings beat a plan entry for the same word', () => {
    const lex = loadLexicon({ theiacast: 'THEE-uh-cast', Zorbo: 'zor-bo' });
    assert.equal(applyPronunciations('TheiaCast', lexiconFor(lex, 'tts')), 'Theea cast');
    assert.equal(applyPronunciations('Zorbo', lexiconFor(lex, 'tts')), normalizeRespelling('zor-bo'));
  });
});

describe('speakChecked', () => {
  it('re-records until the brand is heard right, keeping the best take', async () => {
    const { speakChecked } = await import('../src/agents/explainer/assets.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'say-'));
    const heardAs = ['Visit VA Cast today', 'Visit Satya Cast today', 'Visit TheaCast today'];
    let n = 0;
    const speakFn = async () => Buffer.from(`take${++n}`);
    const transcribeFn = async () => heardAs[n - 1].split(' ').map(text => ({ text }));
    const checks = [{ word: 'TheiaCast', good: ['TheiaCast', 'TheaCast'], bad: ['Theeacast'], count: 1 }];
    const buf = await speakChecked(dir, speakFn, checks, 'scene 1', () => {}, { transcribeFn });
    assert.equal(buf.toString(), 'take3');
    assert.equal(n, 3);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('mispronunciation', () => {
  const check = { good: ['TheiaCast', 'TheaCast'], bad: ['Theeacast'], count: 2 };
  it('passes right takes and catches the literal thee-ee-ay reading', () => {
    assert.ok(mispronunciation('Visit TheaCast.com to download TheaCast'.split(' '), check) <= 0.15);
    assert.ok(mispronunciation('Visit theeacast.com to download the eacast'.split(' '), check) > 0.15);
    assert.ok(mispronunciation('Visit TheaCast.com to download the eacast'.split(' '), check) > 0.15); // one bad occurrence fails the line
  });
  it('re-takes cycle through tts alternatives', () => {
    const lex = { TheiaCast: { tts: ['Theea cast', 'Thea cast'] } };
    assert.equal(lexiconFor(lex, 'tts', 1).TheiaCast, 'Thea cast');
    assert.equal(lexiconFor(lex, 'tts', 2).TheiaCast, 'Theea cast');
  });
});
