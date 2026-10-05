import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sceneDuration, layoutTimeline, captionChunks, buildIndexHtml, fallbackSceneHtml } from '../src/agents/explainer/timeline.js';

const plan = {
  title: 'T & <Co>',
  palette: { bg: '#000000', text: '#ffffff', accent: '#ff0066' },
  font: 'Inter',
  scenes: [
    { type: 'title', speech: '', headline: 'Hi', bullets: [] },
    { type: 'presenter', speech: 'Hello there.', headline: 'P', bullets: ['a'] },
    { type: 'narrated', speech: 'Some words.', headline: 'N', bullets: ['x', 'y'] },
    { type: 'outro', speech: '', headline: 'Bye', bullets: [] },
  ],
};
const assets = [
  {},
  { clipFile: 'assets/p1.mp4', clipDur: 8.04, words: [{ text: 'Hello', start: 0.1, end: 0.5 }, { text: 'there.', start: 0.55, end: 0.9 }] },
  { voiceFile: 'assets/v2.wav', voiceDur: 2.0, imageFile: 'assets/i2.png', sfxFile: 'assets/s2.flac', words: [{ text: 'Some', start: 0, end: 0.3 }, { text: 'words.', start: 0.35, end: 0.8 }] },
  {},
];

describe('timeline layout', () => {
  it('sizes scenes from real assets', () => {
    assert.equal(sceneDuration(plan.scenes[1], assets[1]), 8.04);
    assert.equal(sceneDuration(plan.scenes[2], assets[2]), 2.9); // 0.3 lead + 2.0 + 0.6 tail
    assert.equal(sceneDuration(plan.scenes[0], {}), 3.5);
    assert.equal(sceneDuration(plan.scenes[3], {}), 4);
  });
  it('lays scenes end to end', () => {
    const slots = layoutTimeline(plan.scenes, assets);
    assert.deepEqual(slots.map(s => s.start), [0, 3.5, 11.54, 14.44]);
  });
});

describe('captionChunks', () => {
  it('breaks on sentence end, pauses and max words', () => {
    const words = 'one two three four five six'.split(' ').map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 }));
    words.push({ text: 'later.', start: 5, end: 5.4 });
    const c = captionChunks(words, 10, 20);
    assert.deepEqual(c.map(x => x.text), ['one two three four five', 'six', 'later.']);
    assert.equal(c[0].start, 10);
    assert.ok(c.at(-1).start + c.at(-1).duration <= 20);
  });
});

describe('buildIndexHtml', () => {
  const html = buildIndexHtml(plan, assets, { musicFile: 'assets/music.flac' });
  it('sets root duration to the sum of scenes', () => {
    assert.match(html, /data-composition-id="main"[^>]*data-duration="18.44"/);
  });
  it('places every media element with an id (renderer requirement)', () => {
    for (const tag of html.match(/<(audio|video)\b[^>]*>/g)) assert.match(tag, /\bid="/);
    assert.match(html, /<video id="presenter-1"[^>]*data-has-audio="true"/);
    assert.match(html, /<audio id="vo-2"[^>]*data-start="11.84"/); // voice lead-in
  });
  it('mounts one scene sub-composition per scene and escapes text', () => {
    assert.equal((html.match(/data-composition-src="compositions\/scene-\d\.html"/g) ?? []).length, 4);
    assert.match(html, /<title>T &amp; &lt;Co&gt;<\/title>/);
  });
  it('emits captions from word timings', () => {
    assert.match(html, /class="clip caption"[^>]*><span>Hello there\.<\/span>/);
  });
});

describe('fallbackSceneHtml', () => {
  it('honours the sub-composition contract', () => {
    const f = fallbackSceneHtml('scene-2', plan.scenes[2], { palette: plan.palette, font: 'Inter', duration: 5 });
    assert.match(f, /<template>[\s\S]*<\/template>/);
    assert.match(f, /data-composition-id="scene-2"/);
    assert.match(f, /window\.__timelines\["scene-2"\] = tl/);
    assert.equal((f.match(/fromTo\("#scene-2-b\d"/g) ?? []).length, 2);
  });
});
