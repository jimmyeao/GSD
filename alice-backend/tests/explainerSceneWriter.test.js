import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractHtml, staticCheck, writeScenes, belongsTo } from '../src/agents/explainer/sceneWriter.js';

const good = (id, text = 'Hi') => `<!doctype html><html><head></head><body><template><style>#root{position:absolute;inset:0;font-family:"Inter",sans-serif}</style>
<div id="root" data-composition-id="${id}" data-width="1920" data-height="1080"><h1 id="${id}-h">${text}</h1></div>
<script>const tl=gsap.timeline({paused:true});tl.from("#${id}-h",{opacity:0,duration:0.5},0.2);window.__timelines["${id}"]=tl;</script>
</template></body></html>`;

describe('extractHtml', () => {
  it('strips fences and prose', () => {
    assert.equal(extractHtml('Here you go:\n```html\n<!doctype html><html></html>\n```'), '<!doctype html><html></html>');
    assert.equal(extractHtml('nothing'), '');
  });
});

describe('staticCheck', () => {
  it('passes a valid file', () => assert.deepEqual(staticCheck(good('scene-1'), 'scene-1', 'Inter'), []));
  it('flags media, network, randomness, bad fonts and wrong ids', () => {
    const bad = good('scene-1')
      .replace('<h1', '<img src="x.png"><h1')
      .replace('"Inter",sans-serif', '"Comic Sans MS",sans-serif')
      .replace('tl.from', 'Math.random();tl.from');
    const p = staticCheck(bad, 'scene-2', 'Inter').join('\n');
    assert.match(p, /data-composition-id="scene-2"/);
    assert.match(p, /<img>/);
    assert.match(p, /Math\.random/);
    assert.match(p, /Comic Sans MS/);
  });
});

describe('belongsTo', () => {
  const slots = [{ start: 0, duration: 3 }, { start: 3, duration: 4 }];
  it('attributes by scene file, else runtime findings by time', () => {
    assert.ok(belongsTo({ sourceFile: 'compositions/scene-1.html' }, 1, slots));
    assert.ok(!belongsTo({ sourceFile: 'compositions/scene-1.html' }, 0, slots));
    assert.ok(belongsTo({ stage: 'runtime', sourceFile: 'index.html', time: 3.5 }, 1, slots));
    assert.ok(!belongsTo({ stage: 'layout', sourceFile: 'index.html', time: 3.5 }, 1, slots));
  });
  it('rejects files that drop planned on-screen text', () => {
    const p = staticCheck(good('scene-1', 'Hello'), 'scene-1', 'Inter', { headline: 'Hello', bullets: ['Fast setup'] }).join();
    assert.match(p, /missing on-screen text.*Fast setup/);
    assert.deepEqual(staticCheck(good('scene-1', 'Hello <div>Fast &amp; setup</div>'), 'scene-1', 'Inter', { headline: '*Hello*', bullets: ['Fast & setup'] }), []);
  });
  it('flags gsap plugin usage statically', () => {
    assert.match(staticCheck(good('scene-1').replace('opacity:0', 'text:"x"'), 'scene-1', 'Inter').join(), /plugins/);
  });
});

describe('writeScenes', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'scenes-')); mkdirSync(join(dir, 'compositions')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const plan = {
    palette: { bg: '#000000', text: '#ffffff', accent: '#ff0066' }, font: 'Inter',
    scenes: [
      { type: 'title', headline: 'A', bullets: [] },
      { type: 'narrated', headline: 'B', bullets: ['x'] },
      { type: 'outro', headline: 'C', bullets: [] },
    ],
  };
  const info = [{ duration: 3 }, { duration: 4 }, { duration: 3 }];
  const slots = [{ start: 0, duration: 3 }, { start: 3, duration: 4 }, { start: 7, duration: 3 }];

  it('keeps LLM scenes that pass, repairs lint failures, falls back after max rounds', async () => {
    const calls = { 0: 0, 1: 0, 2: 0 };
    const completeFn = async (_e, _m, messages) => {
      const id = messages[0].content.match(/data-composition-id="(scene-\d)"/)[1];
      const n = Number(id.at(-1));
      calls[n]++;
      if (n === 0) return good(id, 'A');                        // passes first time
      if (n === 1) return calls[n] === 1 ? 'oops' : good(id, 'B <span>x</span>'); // fixed on round 1
      return '<html>no template</html>';                    // never valid
    };
    const check = async () => ({ ok: true, findings: [] });
    const res = await writeScenes(dir, plan, info, { llm: { endpoint: 'e', model: 'm' }, check, slots, completeFn });
    assert.deepEqual(res.map(r => r.source), ['llm', 'llm', 'fallback']);
    assert.deepEqual(calls, { 0: 1, 1: 2, 2: 3 });       // scene 2: initial + 2 fix rounds
    assert.match(readFileSync(join(dir, 'compositions/scene-2.html'), 'utf8'), /id="scene-2-h"/); // layout on disk
  });

  it('feeds check findings for that scene back to the model', async () => {
    let fixPrompt = '';
    const completeFn = async (_e, _m, messages) => {
      if (messages.length > 2) fixPrompt = messages.at(-1).content;
      return good('scene-0', 'A');
    };
    let n = 0;
    const check = async () => (n++ === 0
      ? { ok: false, findings: [{ stage: 'layout', sourceFile: 'compositions/scene-0.html', code: 'content_overlap', message: 'Two text blocks overlap', text: 'A' }] }
      : { ok: true, findings: [] });
    const res = await writeScenes(dir, { ...plan, scenes: [plan.scenes[0]] }, [info[0]], { llm: { endpoint: 'e', model: 'm' }, check, slots: [slots[0]], completeFn });
    assert.equal(res[0].source, 'llm');
    assert.match(fixPrompt, /content_overlap/);
  });
});
