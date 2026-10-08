import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseStudioPrompt, applyDirectEdit } from '../src/agents/explainer/directEdit.js';

const studioPrompt = `Make the headline bigger and gold
Element: Headline (#scene-1-h)
File: compositions/scene-1.html:14
Position: x=120, y=300
Size: 900×110
Tag: <h1>`;

const scene = (text, extra = '') => `<!doctype html><html><head></head><body><template><style>#root{position:absolute;inset:0;font-family:"Inter",sans-serif}${extra}</style>
<div id="root" data-composition-id="scene-1" data-width="1680" data-height="760"><h1 id="scene-1-h">${text}</h1></div>
<script>const tl=gsap.timeline({paused:true});tl.fromTo("#scene-1-h",{opacity:0},{opacity:1,duration:0.5},0.2);window.__timelines["scene-1"]=tl;</script>
</template></body></html>`;

describe('parseStudioPrompt', () => {
  it('finds the File: line from a Studio "Copy prompt"', () => {
    assert.deepEqual(parseStudioPrompt(studioPrompt), { file: 'compositions/scene-1.html' });
    assert.deepEqual(parseStudioPrompt('File: index.html:3'), { file: 'index.html' });
  });
  it('ignores ordinary messages and refuses paths outside the composition files', () => {
    assert.equal(parseStudioPrompt('make scene 2 shorter'), null);
    assert.equal(parseStudioPrompt('File: ../../etc/passwd.html'), null);
    assert.equal(parseStudioPrompt('File: assets/x.html'), null);
  });
});

describe('applyDirectEdit', () => {
  let dir;
  const plan = { font: 'Inter', scenes: [{}, {}] };
  const slots = [{ start: 0, duration: 3 }, { start: 3, duration: 4 }];
  before(() => { dir = mkdtempSync(join(tmpdir(), 'edit-')); mkdirSync(join(dir, 'compositions')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('applies a passing edit', async () => {
    writeFileSync(join(dir, 'compositions/scene-1.html'), scene('Old'));
    const res = await applyDirectEdit(dir, plan, slots, studioPrompt, {
      llm: { endpoint: 'e', model: 'm' }, completeFn: async () => scene('New', '#scene-1-h{color:#ffd700;font-size:120px}'), check: async () => ({ findings: [] }),
    });
    assert.ok(res.ok);
    assert.match(readFileSync(join(dir, 'compositions/scene-1.html'), 'utf8'), /New/);
  });

  it('reverts and retries when checks fail, and never leaves a broken file', async () => {
    writeFileSync(join(dir, 'compositions/scene-1.html'), scene('Keep me'));
    let calls = 0;
    const res = await applyDirectEdit(dir, plan, slots, studioPrompt, {
      llm: { endpoint: 'e', model: 'm' },
      completeFn: async () => { calls++; return scene('Broken', '#scene-1 .x{color:red}'); }, // dangling #scene-1 selector
      check: async () => ({ findings: [] }),
    });
    assert.equal(res.ok, false);
    assert.equal(calls, 2);
    assert.match(res.problems.join(), /scene-1/);
    assert.match(readFileSync(join(dir, 'compositions/scene-1.html'), 'utf8'), /Keep me/);
  });

  it('rolls back when hyperframes check flags the edited file', async () => {
    writeFileSync(join(dir, 'compositions/scene-1.html'), scene('Original'));
    const res = await applyDirectEdit(dir, plan, slots, studioPrompt, {
      llm: { endpoint: 'e', model: 'm' }, completeFn: async () => scene('Overlapping'),
      check: async () => ({ findings: [{ stage: 'layout', sourceFile: 'compositions/scene-1.html', code: 'content_overlap', message: 'overlap' }] }),
    });
    assert.equal(res.ok, false);
    assert.match(readFileSync(join(dir, 'compositions/scene-1.html'), 'utf8'), /Original/);
  });
});
