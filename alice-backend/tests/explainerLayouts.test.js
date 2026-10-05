import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, revealTimes, layoutFits, buildLayoutHtml, defaultLayout } from '../src/agents/explainer/layouts.js';

const ctx = { palette: { bg: '#000000', text: '#ffffff', accent: '#ff0066' }, font: 'Inter', duration: 6, canvas: { width: 1680, height: 760 } };
const scene = (over = {}) => ({ type: 'narrated', headline: 'Big *idea* here', bullets: ['Fast setup', 'Live data'], steps: ['Connect', 'Pick', 'Share'],
  stat: { from: 0, to: 87, prefix: '', suffix: '%', label: 'less time' },
  compare: { left_title: 'Before', left: ['Hours'], right_title: 'After', right: ['One click'] }, ...over });

describe('revealTimes', () => {
  const words = [{ text: 'We', start: 0.2 }, { text: 'have', start: 0.4 }, { text: 'fast', start: 1.5 }, { text: 'setup', start: 1.8 }, { text: 'and', start: 2.2 }, { text: 'live', start: 3.4 }];
  it('aligns items to their spoken words', () => {
    assert.deepEqual(revealTimes(['Fast setup', 'Live data'], words, { latest: 5 }), [1.35, 3.25]);
  });
  it('staggers when there are no matching words, capped at latest', () => {
    assert.deepEqual(revealTimes(['x', 'y', 'z'], [], { firstAt: 1, gap: 2, latest: 3.5 }), [1, 3, 3.5]);
  });
});

describe('layout selection', () => {
  it('falls back when content does not fit the layout', () => {
    assert.ok(!layoutFits('stat', scene({ stat: null })));
    assert.ok(!layoutFits('compare', scene({ compare: null })));
    assert.equal(defaultLayout({ type: 'outro' }), 'cta');
    const html = buildLayoutHtml('scene-1', scene({ layout: 'stat', stat: null }), ctx);
    assert.match(html, /scene-1-list/); // bullets layout used instead
  });
});

describe('every layout honours the sub-composition contract', () => {
  for (const layout of LAYOUTS) {
    it(layout, () => {
      const html = buildLayoutHtml('scene-3', scene({ layout }), ctx);
      assert.match(html, /<template>[\s\S]*<\/template>/);
      assert.match(html, /data-composition-id="scene-3" data-width="1680" data-height="760"/);
      assert.match(html, /window\.__timelines\["scene-3"\] = tl/);
      assert.doesNotMatch(html, /Math\.random|https?:|<img|<br/);
    });
  }
  it('stat counts with a plain-object tween (no gsap plugin)', () => {
    const html = buildLayoutHtml('scene-3', scene({ layout: 'stat' }), ctx);
    assert.match(html, /tl\.fromTo\(counter, \{ v: 0 \}, \{ v: 87/);
    assert.match(html, /num\.textContent =/);
  });
  it('statement highlights *marked* words', () => {
    const html = buildLayoutHtml('scene-3', scene({ layout: 'statement' }), ctx);
    assert.match(html, /class="scene-3-w accent">idea</);
    assert.doesNotMatch(html, /\*/);
  });
});

describe('highlight markup', () => {
  it('renders *word* as an accent span in every layout, never literal asterisks', () => {
    for (const layout of LAYOUTS) {
      const html = buildLayoutHtml('scene-1', scene({ layout, headline: 'Perfect *timing* every *time', bullets: ['A *b* c', 'd'] }), ctx);
      assert.doesNotMatch(html.replace(/<script[\s\S]*<\/script>/, ''), /\*/, layout);
    }
    assert.match(buildLayoutHtml('scene-1', scene({ layout: 'bullets', headline: 'Perfect *timing*' }), ctx), /Perfect <span class="accent">timing<\/span>/);
  });
});
