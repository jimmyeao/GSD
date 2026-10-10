import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isApproval, storyboardMarkdown } from '../src/agents/explainer/session.js';

describe('isApproval', () => {
  it('accepts short approvals', () => {
    for (const t of ['approve', 'Approved!', 'go', 'go ahead', 'render it', 'looks good', 'LGTM', 'yes, render', 'ship it', 'ok go']) assert.ok(isApproval(t), t);
  });
  it('treats anything substantive as feedback', () => {
    for (const t of ['approve but change scene 3', 'go with a female presenter', 'make it shorter', 'yes but drop the stat', 'looks good except the title']) assert.ok(!isApproval(t), t);
  });
});

describe('storyboardMarkdown', () => {
  it('renders one row per scene with timing, visual source and escaped cells', () => {
    const plan = {
      title: 'TheiaCast', font: 'Inter', palette: { bg: '#000000', accent: '#00ffcc' }, presenter: null, music: { prompt: 'calm synth' },
      scenes: [
        { type: 'title', layout: 'title', headline: 'TheiaCast', bullets: [], steps: [], speech: '', media: '', image_prompt: '' },
        { type: 'narrated', layout: 'showcase', headline: 'Dashboard | live', bullets: ['A'], steps: [], speech: 'Control every screen.', media: 'img2', image_prompt: '' },
      ],
    };
    const md = storyboardMarkdown(plan, [{ start: 0, duration: 3.5 }, { start: 3.5, duration: 4 }], { images: [{ id: 'img2', name: 'dashboard.png' }] });
    assert.match(md, /Storyboard — TheiaCast/);
    assert.match(md, /\| 2 \| 3\.5s \| showcase \| Dashboard \\\| live · A \| 🖼 your image: dashboard\.png \| — \| Control every screen\. \|/);
    assert.match(md, /~8s · 2 scenes/);
  });
});

describe('path safety', async () => {
  const { projectDir } = await import('../src/agents/explainer/pipeline.js');
  const { handleExplainerTurn } = await import('../src/agents/explainer/session.js');
  it('rejects project ids that could escape data/explainers', () => {
    for (const bad of ['../x', 'a/b', '..', '', 'conv-1/../../etc']) assert.throws(() => projectDir(bad), /invalid project/);
  });
  it('rejects non-numeric conversation ids', async () => {
    await assert.rejects(handleExplainerTurn({ convId: '../../tmp', message: 'x' }, { say() {}, progress() {}, saveVideo() {} }), /invalid conversation id/);
  });
});
