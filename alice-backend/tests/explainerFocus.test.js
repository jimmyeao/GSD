import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBoxes, normaliseBox, matchBoxes, locateFocus } from '../src/agents/explainer/focus.js';
import { focusTweens } from '../src/agents/explainer/layouts.js';

describe('focus boxes', () => {
  it('parses the JSON array out of a fenced reply', () => {
    assert.deepEqual(parseBoxes('```json\n[{"label":"A","bbox_2d":[1,2,3,4]}]\n```'), [{ label: 'A', bbox_2d: [1, 2, 3, 4] }]);
    assert.deepEqual(parseBoxes('no boxes here'), []);
  });
  it('normalises, clamps and rejects useless boxes', () => {
    assert.deepEqual(normaliseBox({ bbox_2d: [160, 90, 480, 270] }, 1600, 900), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    assert.equal(normaliseBox({ bbox_2d: [0, 0, 1600, 900] }, 1600, 900), null); // whole screen
    assert.equal(normaliseBox({ bbox_2d: [10, 10, 14, 14] }, 1600, 900), null);  // near-zero
    assert.ok(normaliseBox({ bbox_2d: [288, 165, 650, 190] }, 1600, 900));       // a 25px-tall filter chip
    assert.equal(normaliseBox({ bbox_2d: ['a', 1, 2, 3] }, 1600, 900), null);
  });
  it('matches by label first, then by order when counts agree', () => {
    const boxes = [{ label: 'live screenshots', bbox_2d: [0, 450, 400, 900] }, { label: 'Fleet status', bbox_2d: [0, 0, 400, 300] }];
    const [a, b] = matchBoxes(['Fleet status', 'Live screenshots'], boxes, 1600, 900);
    assert.equal(a.y, 0);
    assert.equal(b.y, 0.5);
  });
});

describe('locateFocus', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'focus-'));
    mkdirSync(join(dir, 'assets'));
    copyFileSync(new URL('../data/explainers/conv-209/assets/media-img1.png', import.meta.url), join(dir, 'assets/shot.png'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('asks the vision model once, then serves the cached result', async () => {
    let calls = 0;
    const fetchFn = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).keep_alive, 0);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"label":"Fleet status","bbox_2d":[257,340,1156,520]}]' } }] }) };
    };
    const r1 = await locateFocus(dir, 'assets/shot.png', ['Fleet status', 'Nope'], { fetchFn });
    assert.equal(r1.size.width, 1600);
    assert.ok(r1.focus[0] && r1.focus[1] === null);
    const r2 = await locateFocus(dir, 'assets/shot.png', ['Fleet status', 'Nope'], { fetchFn });
    assert.deepEqual(r2, r1);
    assert.equal(calls, 1);
    assert.equal(readdirSync(join(dir, 'assets')).filter(f => f.startsWith('focus-')).length, 1);
  });
});

describe('focusTweens', () => {
  it('zooms to each region in order and keeps the image covering the window', () => {
    const js = focusTweens('#s-img', { focus: [{ x: 0.1, y: 0.4, w: 0.5, h: 0.2 }, null, { x: 0.7, y: 0.4, w: 0.25, h: 0.6 }], size: { width: 1600, height: 900 }, times: [1.5, 3, 5], width: 1000, duration: 10 });
    const tos = [...js.matchAll(/tl\.to\("#s-img", \{ x: (-?[\d.]+), y: (-?[\d.]+), scale: ([\d.]+)/g)].map(m => m.slice(1).map(Number));
    assert.equal(tos.length, 3); // two targets + pull back
    for (const [x, y, sc] of tos) {
      assert.ok(x <= 0 && x >= 1000 * (1 - sc) - 5); // scale is printed rounded
      assert.ok(y <= 0 && y >= 562.5 * (1 - sc) - 5);
    }
    assert.deepEqual(tos.at(-1), [0, 0, 1]);
  });
  it('is empty without targets', () => {
    assert.equal(focusTweens('#s', { focus: [null], size: { width: 10, height: 10 }, times: [1], width: 100, duration: 5 }), '');
  });
});
