/**
 * Direct composition edits — Alice standing in for HyperFrames' "Framey".
 *
 * Browser Studio has no built-in agent: its agent panel only builds a
 * "Copy prompt to AI agent" message (Element / File / Position / Size /
 * Tag / Animation lines + the user's request). Pasting that into the
 * video's Alice conversation lands here: the named file is edited by the
 * LLM, validated (scene static checks + `hyperframes check`), reverted and
 * retried once on failure — a bad edit never survives — then re-rendered.
 * An open Studio picks the change up live (it watches project files).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { complete } from '../llmClient.js';
import { staticCheck, belongsTo, extractHtml } from './sceneWriter.js';
import { checkProject } from './hyperframesCli.js';

const FILE_LINE = /^\s*File:\s*([\w./-]+?\.html)(?::\d+)?\s*$/m;
const ALLOWED = /^(index\.html|compositions\/[\w-]+\.html)$/;
const ANTI_SECOND_GUESS = 'Think briefly, write the file once, and output it immediately — do not reconsider, revise, or second-guess it once written.';

/** Is this message a Studio "Copy prompt" (or an explicit File: edit request)? */
export function parseStudioPrompt(message) {
  const m = FILE_LINE.exec(message ?? '');
  if (!m) return null;
  const file = m[1].replace(/^\.?\//, '');
  return ALLOWED.test(file) ? { file } : null;
}

function safePath(dir, file) {
  const p = resolve(dir, file);
  if (!p.startsWith(resolve(dir) + sep)) throw new Error('invalid file path');
  return p;
}

function buildEditPrompt(file, html, message, font) {
  const isScene = file.startsWith('compositions/');
  const w = /data-width="(\d+)"/.exec(html)?.[1], h = /data-height="(\d+)"/.exec(html)?.[1];
  const system = `You edit ONE file of a HyperFrames video project (HTML + GSAP, rendered frame-by-frame to video). Apply exactly the change the client asks for to the element they selected, and change nothing else. Output ONLY the complete edited file, no prose, no code fences.

Rules:
- Keep the file's structure: ${isScene ? 'everything stays inside <template>; keep the root\'s data-composition-id/data-width/data-height and the window.__timelines[...] registration' : 'keep every data-start/data-duration/data-track-index, every id, and the window.__timelines["main"] registration'} unless the client explicitly asks to change timing.
- One paused gsap timeline; tween positions are absolute seconds. Set initial states inside tweens (fromTo/from), never with a CSS transform on the same property.
- Core gsap only (no plugins, no text: tweens). No Math.random/Date/timers, no repeat: -1, no <br>, no emoji, no external URLs.
- Fonts: only "${font}" (or generic families).
- Every #id used in CSS/JS must exist on an element.
${w && h ? `- This composition's canvas is ${w}x${h}px. ALL text must stay fully inside it and must not cover other text: if the request can't fit literally (e.g. "much bigger"), make the closest change that fits — the largest size that still wraps cleanly within ${w}px and leaves room for the other elements.
` : ''}${ANTI_SECOND_GUESS}`;
  const user = `The client's request (copied from HyperFrames Studio, with the selected element's details):\n${message}\n\nCurrent ${file}:\n${html}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * @returns {Promise<{ok: boolean, file: string, attempts: number, problems: string[]}>}
 */
export async function applyDirectEdit(dir, plan, slots, message, { llm, completeFn = complete, check = checkProject } = {}) {
  const target = parseStudioPrompt(message);
  if (!target) throw new Error('no File: line pointing at index.html or compositions/*.html');
  const path = safePath(dir, target.file);
  if (!existsSync(path)) throw new Error(`${target.file} does not exist in this project`);
  const original = readFileSync(path, 'utf8');
  const compId = /compositions\/(scene-\d+)\.html$/.exec(target.file)?.[1];
  const sceneIndex = compId ? Number(compId.split('-')[1]) : -1;
  const messages = buildEditPrompt(target.file, original, message, plan.font);

  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await completeFn(llm.endpoint, llm.model, messages, { numPredict: 16_000, temperature: 0.3, signal: AbortSignal.timeout(420_000) });
    const html = extractHtml(reply);
    problems = !html ? ['no complete HTML file in the reply']
      : compId ? staticCheck(html, compId, plan.font)
      : (!html.includes('data-composition-id="main"') || !/window\.__timelines\[["']main["']\]/.test(html) ? ['the root composition (data-composition-id="main") and its timeline registration must be kept'] : []);
    if (!problems.length) {
      writeFileSync(path, html);
      const { findings } = await check(dir);
      problems = findings
        .filter(f => (compId ? belongsTo(f, sceneIndex, slots) : (f.sourceFile ?? '').endsWith('index.html')))
        .map(f => `${f.code}: ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ''}`);
      if (!problems.length) return { ok: true, file: target.file, attempts: attempt, problems: [] };
      writeFileSync(path, original); // never leave a broken edit on disk
    }
    messages.push({ role: 'assistant', content: reply || '(empty)' }, { role: 'user', content: `That edit was rejected:\n${problems.map(p => `- ${p}`).join('\n')}\nReturn the complete corrected file only.` });
  }
  return { ok: false, file: target.file, attempts: 2, problems };
}
