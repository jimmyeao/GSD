import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFx, applySceneFx, transitionTweens, wordSpans, overlayLayer } from '../src/agents/explainer/effects.js';
import { curate, menuText, NATIVE } from '../src/agents/explainer/catalog.js';
import { buildLayoutHtml } from '../src/agents/explainer/layouts.js';

const ctx = { palette: { bg: '#000000', text: '#ffffff', accent: '#ff6600' }, font: 'Inter', duration: 6, canvas: { width: 1680, height: 760 } };

describe('effects', () => {
  it('maps catalogue names to native ids and keeps the rest for adaptation', () => {
    assert.deepEqual(resolveFx({ transition: 'whip-pan-cut', items: ['per-word-rise', 'hw-callout-circle', 'tracing-beam'] }),
      { transition: 'whip', text: 'word-rise', callout: 'circle', adapt: ['tracing-beam'] });
  });
  it('wraps headline words, keeping the accent class', () => {
    assert.equal(wordSpans('Hi <span class="accent">big world</span>', 'w'), '<span class="w">Hi</span> <span class="w accent">big</span> <span class="w accent">world</span>');
  });
  it('applies word-rise and marker to a template headline', () => {
    const scene = { type: 'narrated', layout: 'statement', headline: 'Run *every* screen', bullets: [] };
    const rise = buildLayoutHtml('scene-1', { ...scene, layout: 'bullets', bullets: ['a'], effects: { items: ['per-word-rise'] } }, ctx);
    assert.match(rise, /<span class="scene-1-w accent">every<\/span>/);
    assert.match(rise, /#scene-1-h \.scene-1-w/);
    const mark = buildLayoutHtml('scene-1', { ...scene, effects: { items: ['marker-highlight'] } }, ctx);
    assert.match(mark, /id="scene-1-mkr"/);
    assert.match(mark, /strokeDashoffset: 0/);
  });
  it('gives every native transition real tweens', () => {
    for (const type of ['whip', 'iris', 'leak', 'zoom', 'flash', 'wipe', 'push', 'crossfade']) {
      assert.ok(transitionTweens(type, { i: 2, prev: 1, t: 10, D: 0.6, W: 1920, H: 1080 }).length >= 1, type);
    }
  });
  it('builds overlays', () => {
    assert.match(overlayLayer('grain', 30).html, /ov-grain/);
    assert.equal(overlayLayer('none', 30).html, '');
  });
});

describe('catalog', () => {
  it('curates: keeps natives, drops vertical/social items and non-native transitions', () => {
    const items = [
      { name: 'whip-pan-cut', type: 'component', tags: ['transition'], description: 'x' },
      { name: 'glitch', type: 'block', tags: ['transition', 'shader'], description: 'x' },
      { name: 'tiktok-follow', type: 'block', tags: ['social'], description: 'x' },
      { name: 'tracing-beam', type: 'component', tags: ['product-demo'], description: 'glowing dash' },
      { name: 'notes-x', type: 'block', tags: ['typography'], dimensions: { width: 1080, height: 1920 }, description: 'x' },
    ];
    const m = curate(items);
    assert.deepEqual(m.map(x => x.name), ['whip-pan-cut', 'tracing-beam']);
    assert.match(menuText(m), /whip-pan-cut \[native\]/);
    assert.ok(Object.keys(NATIVE).length > 20);
  });
});
