import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findUnsupportedClaims, scrubClaims } from '../src/agents/explainer/grounding.js';
import { normalizePlan, planExplainer } from '../src/agents/explainer/planner.js';
import { pickVoice } from '../src/agents/explainer/assets.js';

const brief = 'Promo for BrewBuddy, a smart coffee scale that times your pour-over. Launch price 59 pounds at brewbuddy.example. Works with 1,200 recipes.';
const plan = { scenes: [
  { type: 'narrated', speech: 'BrewBuddy times every pour. Get 10% off with code COFFEE10 today.', headline: 'Precision brewing', bullets: ['1200 recipes', 'Free trial included'] },
  { type: 'outro', speech: '', headline: 'Only 59 pounds', bullets: ['Start your free trial'] },
] };

describe('findUnsupportedClaims', () => {
  it('flags invented codes, percentages and offers but not facts from the brief', () => {
    const claims = findUnsupportedClaims(plan, brief).map(x => x.claim).sort();
    assert.deepEqual([...new Set(claims)].sort(), ['10%', 'coffee10', '% off', 'free trial', 'trial'].sort());
  });
  it('accepts numbers that appear in the brief (incl. thousands separators)', () => {
    assert.deepEqual(findUnsupportedClaims({ scenes: [{ speech: 'Only 59 pounds, with 1,200 recipes.', bullets: [] }] }, brief), []);
  });
});

describe('scrubClaims', () => {
  it('drops the offending sentence / bullet and keeps the rest', () => {
    const p = scrubClaims(plan, findUnsupportedClaims(plan, brief));
    assert.equal(p.scenes[0].speech, 'BrewBuddy times every pour.');
    assert.deepEqual(p.scenes[0].bullets, ['1200 recipes']);
    assert.deepEqual(p.scenes[1].bullets, []);
  });
});

describe('planExplainer grounding loop', () => {
  const opts = { brief, format: 'promo', presenter: false, maxPresenterScenes: 0, targetSeconds: 30 };
  it('asks the planner to fix unsupported claims, then scrubs what remains', async () => {
    const bad = JSON.stringify({ title: 'BrewBuddy', scenes: [{ type: 'narrated', speech: 'Great coffee. Use code COFFEE10 for 10% off.', headline: 'Brew better' }] });
    let n = 0;
    const plan2 = await planExplainer({ endpoint: 'e', model: 'm' }, opts, { completeFn: async (_e, _m, msgs) => { n++; if (n === 2) assert.match(msgs.at(-1).content, /COFFEE10|coffee10/i); return bad; } });
    assert.equal(n, 2);
    const speech = plan2.scenes.find(s => s.type === 'narrated').speech;
    assert.equal(speech, 'Great coffee.');
    assert.ok(plan2.removedClaims.includes('coffee10'));
  });
});

describe('presenter gender', () => {
  const opts = { presenter: true, maxPresenterScenes: 1 };
  it('makes face and voice agree', () => {
    const p = normalizePlan({ presenter: { gender: 'male', description: 'barista in his 30s, dark apron' }, scenes: [{ type: 'presenter', speech: 'Hi.' }] }, opts);
    assert.equal(p.presenter.gender, 'male');
    assert.equal(pickVoice(p.presenter), 'bm_george');
    const q = normalizePlan({ presenter: { description: 'barista, 30s, dark apron, warm smile' }, scenes: [{ type: 'presenter', speech: 'Hi.' }] }, opts);
    assert.equal(q.presenter.gender, 'female');
    assert.match(q.presenter.description, /^a woman, /); // portrait prompt now states it too
    assert.equal(pickVoice(q.presenter), 'bf_alice');
  });
});
