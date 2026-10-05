import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizePlan, planExplainer } from '../src/agents/explainer/planner.js';

const opts = { presenter: true, maxPresenterScenes: 2, brief: 'x', format: 'explainer', targetSeconds: 45 };

describe('extractJson', () => {
  it('pulls JSON out of fenced, chatty replies', () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```\nDone'), { a: { b: '}' } });
  });
  it('returns null for no / broken JSON', () => {
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson('{"a": '), null);
  });
});

describe('normalizePlan', () => {
  const raw = {
    title: 'Dashboards',
    palette: { bg: '#000000', text: 'white', accent: '#ff0066' },
    font: 'Comic Sans',
    presenter: { description: 'woman, navy blazer' },
    scenes: [
      { type: 'presenter', speech: 'Hi there.', headline: 'Hello' },
      { type: 'presenter', speech: 'Second line.', headline: 'Two' },
      { type: 'presenter', speech: 'Third line.', headline: 'Three' },
      { type: 'narrated', speech: '', headline: 'empty, dropped' },
      { type: 'weird', speech: 'Becomes narrated.', headline: 'X' },
    ],
  };

  it('repairs palette/font and caps presenter scenes', () => {
    const p = normalizePlan(raw, opts);
    assert.equal(p.palette.bg, '#000000');
    assert.equal(p.palette.text, '#f5f7ff'); // invalid hex replaced
    assert.equal(p.font, 'Inter');
    assert.equal(p.scenes.filter(s => s.type === 'presenter').length, 2);
    assert.ok(p.presenter);
  });

  it('adds title/outro bookends and drops empty speech scenes', () => {
    const p = normalizePlan(raw, opts);
    assert.equal(p.scenes[0].type, 'title');
    assert.equal(p.scenes.at(-1).type, 'outro');
    assert.ok(!p.scenes.some(s => s.headline === 'empty, dropped'));
    assert.ok(p.scenes.find(s => s.headline === 'X' && s.type === 'narrated').image_prompt);
  });

  it('demotes presenter scenes when presenter is disabled', () => {
    const p = normalizePlan(raw, { ...opts, presenter: false });
    assert.equal(p.presenter, null);
    assert.ok(!p.scenes.some(s => s.type === 'presenter'));
  });

  it('clamps long speech to the word budget', () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const p = normalizePlan({ scenes: [{ type: 'narrated', speech: long }] }, opts);
    assert.ok(p.scenes.find(s => s.type === 'narrated').speech.split(' ').length <= 28);
  });

  it('throws when nothing is spoken', () => {
    assert.throws(() => normalizePlan({ scenes: [{ type: 'title', speech: '' }] }, opts), /no spoken scenes/);
  });
});

describe('planExplainer', () => {
  it('retries once with the parse error, then succeeds', async () => {
    const replies = ['not json', JSON.stringify({ title: 'T', scenes: [{ type: 'narrated', speech: 'Hello world.' }] })];
    const calls = [];
    const completeFn = async (_e, _m, messages) => { calls.push(messages.length); return replies.shift(); };
    const plan = await planExplainer({ endpoint: 'e', model: 'm' }, opts, { completeFn });
    assert.equal(plan.title, 'T');
    assert.deepEqual(calls, [2, 4]); // second call carries the failed reply + correction
  });

  it('gives up after two unusable replies', async () => {
    const completeFn = async () => 'nope';
    await assert.rejects(planExplainer({ endpoint: 'e', model: 'm' }, opts, { completeFn }), /planner failed/);
  });
});

describe('validateExplainerOptions', async () => {
  const { validateExplainerOptions } = await import('../src/agents/explainer/pipeline.js');
  it('applies defaults and trims the brief', () => {
    const { opts } = validateExplainerOptions({ brief: '  A brief about a product  ' });
    assert.deepEqual(opts, { brief: 'A brief about a product', format: 'explainer', presenter: true, maxPresenterScenes: 2, targetSeconds: 45, creative: false, voice: undefined });
  });
  it('rejects bad input', () => {
    assert.match(validateExplainerOptions({ brief: 'short' }).error, /brief/);
    assert.match(validateExplainerOptions({ brief: 'long enough brief', format: 'ad' }).error, /format/);
    assert.match(validateExplainerOptions({ brief: 'long enough brief', maxPresenterScenes: 5 }).error, /0-3/);
    assert.match(validateExplainerOptions({ brief: 'long enough brief', targetSeconds: 600 }).error, /15 and 120/);
    assert.match(validateExplainerOptions({ brief: 'long enough brief', voice: 'x; rm -rf' }).error, /Kokoro/);
  });
});

describe('grounded stats', async () => {
  const { groundedStat } = await import('../src/agents/explainer/planner.js');
  it('keeps numbers from the brief, drops invented ones', () => {
    const brief = 'Teams cut reporting time by 87 percent and saved 1,200 hours. Price 59.99.';
    assert.ok(groundedStat({ from: 0, to: 87 }, brief));
    assert.ok(groundedStat({ from: 0, to: 1200 }, brief));
    assert.ok(groundedStat({ from: 0, to: 59.99 }, brief));
    assert.equal(groundedStat({ from: 0, to: 78 }, brief), null);
  });
  it('normalizePlan applies it', () => {
    const p = normalizePlan({ scenes: [{ type: 'narrated', speech: 'Hi there.', layout: 'stat', stat: { from: 0, to: 78 } }] }, { ...opts, brief: 'no numbers here' });
    assert.equal(p.scenes.find(s => s.type === 'narrated').stat, null);
  });
});
