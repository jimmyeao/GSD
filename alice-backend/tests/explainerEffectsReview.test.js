import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffects, reviewEffects, sceneWriters } from '../src/agents/explainer/effectsReview.js';

const catalog = [
  { name: 'whip-pan-cut', type: 'component', tags: ['transition'], description: 'whip' },
  { name: 'iris-reveal', type: 'component', tags: ['transition'], description: 'iris' },
  { name: 'per-word-rise', type: 'component', tags: ['typography'], description: 'rise' },
  { name: 'hw-callout-circle', type: 'component', tags: ['handwritten', 'callout'], description: 'circle' },
  { name: 'cta-lockup', type: 'component', tags: ['cta'], description: 'cta' },
  { name: 'tracing-beam', type: 'component', tags: ['product-demo'], description: 'beam' },
  { name: 'vignette', type: 'component', tags: ['overlay'], description: 'v' },
];
const plan = { title: 'T', style: 'midnight', palette: { accent: '#ff6600' }, scenes: [
  { type: 'title', layout: 'title', headline: 'Hi', bullets: [] },
  { type: 'narrated', layout: 'showcase', media: 'img1', headline: 'Dash', bullets: ['a'] },
  { type: 'narrated', layout: 'bullets', media: '', headline: 'More', bullets: ['b'] },
  { type: 'outro', layout: 'cta', headline: 'Go', bullets: ['Try'] },
] };

describe('effects review', () => {
  it('marks Qwen-written scenes', () => {
    assert.deepEqual(sceneWriters(plan, true), ['custom', 'template', 'custom', 'custom']);
  });
  it('drops picks that could not render', async () => {
    const { curate } = await import('../src/agents/explainer/catalog.js');
    const fx = normalizeEffects({ overlay: 'vignette', scenes: [
      { transition: 'whip-pan-cut', items: ['cta-lockup'] },                        // no transition into scene 1; cta only on outro
      { transition: 'iris-reveal', items: ['hw-callout-circle', 'tracing-beam'] },  // template scene: non-native dropped
      { transition: 'nope', items: ['tracing-beam', 'hw-callout-circle'] },        // custom: adapt ok; no screenshot → no callout
      { transition: 'whip-pan-cut', items: ['cta-lockup', 'per-word-rise', 'tracing-beam'] }, // max 2
    ] }, plan, curate(catalog), { creative: true });
    assert.equal(fx.overlay, 'vignette');
    assert.deepEqual(fx.scenes.map(s => [s.transition, s.items]), [
      ['', []], ['iris-reveal', ['hw-callout-circle']], ['', ['tracing-beam']], ['whip-pan-cut', ['cta-lockup', 'per-word-rise']],
    ]);
  });
  it('attaches picks to the plan and never throws', async () => {
    const p = structuredClone(plan);
    await reviewEffects({ endpoint: 'e', model: 'm' }, p, { creative: false, catalog, completeFn: async () => '{"overlay":"","scenes":[{},{"transition":"iris-reveal","items":["hw-callout-circle"]},{},{}]}' });
    assert.equal(p.scenes[1].effects.transition, 'iris-reveal');
    const q = structuredClone(plan);
    await reviewEffects({ endpoint: 'e', model: 'm' }, q, { catalog, completeFn: async () => { throw new Error('down'); } });
    assert.equal(q.scenes[1].effects, undefined);
  });
});

describe('scene writer effect references', () => {
  it('describes native picks and attaches source for adapted ones', async () => {
    const { effectNotes, buildScenePrompt } = await import('../src/agents/explainer/sceneWriter.js');
    const notes = await effectNotes({ items: ['per-word-rise', 'tracing-beam'] }, { catalog, source: async (n) => `<div>${n} source</div>` });
    assert.deepEqual(notes.map(n => [n.name, !!n.source]), [['per-word-rise', false], ['tracing-beam', true]]);
    const [, user] = buildScenePrompt('scene-2', { type: 'narrated', headline: 'H', bullets: [] }, { palette: { text: '#fff', accent: '#f60', bg: '#000' }, font: 'Inter', duration: 5, words: [], effects: notes });
    assert.match(user.content, /- tracing-beam: beam/);
    assert.match(user.content, /reference: tracing-beam[\s\S]*tracing-beam source/);
  });
});
