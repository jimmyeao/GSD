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

import { loadCatalog, curate, menuText } from './catalog.js';
import { effectNotes } from './sceneWriter.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { complete } from '../llmClient.js';
import { staticCheck, belongsTo, extractHtml } from './sceneWriter.js';
import { checkProject } from './hyperframesCli.js';

// "File: compositions/scene-2.html:14" (older Studio) or, in the
// "HyperFrames element edit request v1" schema, "Composition: compositions/scene-2.html".
const FILE_LINE = /^\s*(?:File|Composition):\s*([\w./-]+?\.html)(?::\d+)?\s*$/m;
const ALLOWED = /^(index\.html|compositions\/[\w-]+\.html)$/;
const ANTI_SECOND_GUESS = 'Think briefly, write the file once, and output it immediately — do not reconsider, revise, or second-guess it once written.';

const DOM_LINE = /^\s*DOM id:\s*([\w-]+)/m;
// Root-timeline elements that belong to one scene (index.html): clicking a
// scene in Studio usually selects its full-frame background, not its graphics.
const SCENE_HOST = /^(?:bg|bgw|bgx|kb|g|presenter|pph-img|leak|flash)-(\d+)(?:-|$)/;

/**
 * Is this message a Studio "Copy prompt" (or an explicit File: edit request)?
 * Edits aimed at a scene's background/graphics host in index.html are
 * retargeted to that scene's own file (index.html is the whole 24 KB
 * timeline; asking the LLM to rewrite it ran out of output budget).
 * @returns {{file, dom?, scene?, retargeted?}|null}
 */
export function parseStudioPrompt(message) {
  const m = FILE_LINE.exec(message ?? '');
  if (!m) return null;
  const file = m[1].replace(/^\.?\//, '');
  if (!ALLOWED.test(file)) return null;
  const dom = DOM_LINE.exec(message)?.[1];
  const host = file === 'index.html' && dom ? SCENE_HOST.exec(dom) : null;
  if (host) return { file: `compositions/scene-${host[1]}.html`, dom, scene: Number(host[1]), retargeted: true };
  const scene = /compositions\/scene-(\d+)\.html$/.exec(file)?.[1];
  return { file, ...(dom ? { dom } : {}), ...(scene ? { scene: Number(scene) } : {}) };
}

/** The client's own words from a Studio edit request (without the element dump). */
export function studioInstruction(message) {
  return String(message ?? '').split(/\n\s*(?:Composition|File):/)[0]
    .replace(/^\s*#*\s*HyperFrames element edit request v\d+\s*/i, '').replace(/^\s*Schema version:\s*\d+\s*/im, '').trim();
}

function safePath(dir, file) {
  const p = resolve(dir, file);
  if (!p.startsWith(resolve(dir) + sep)) throw new Error('invalid file path');
  return p;
}

/**
 * Catalogue items that would help with this edit (e.g. "show the user typing
 * a prompt" → typed-prompt), picked by the LLM from the curated menu, with
 * their real source for the edit prompt. [] on any failure.
 */
export async function editReferences(llm, instruction, { completeFn = complete } = {}) {
  try {
    const menu = curate(await loadCatalog()).filter(m => !['transition', 'overlay'].includes(m.role));
    const reply = await completeFn(llm.endpoint, llm.model, [
      { role: 'system', content: `Pick at most 2 HyperFrames catalogue items whose technique would help implement the client's edit, or none. Reply ONLY with a JSON array of exact names, e.g. ["typed-prompt"] or [].\n\n${menuText(menu)}` },
      { role: 'user', content: instruction },
    ], { numPredict: 200, temperature: 0, noThink: true, signal: AbortSignal.timeout(90_000) });
    const names = JSON.parse(/\[[\s\S]*?\]/.exec(String(reply))?.[0] ?? '[]').filter(n => menu.some(m => m.name === n)).slice(0, 2);
    return (await effectNotes({ items: names })).filter(n => n.source || n.description);
  } catch { return []; }
}

function buildEditPrompt(file, html, message, font, retargeted = false, refs = []) {
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
  const note = retargeted ? `\n\n(The client clicked this scene's full-frame background in Studio; the request is about this scene, so apply it to this scene's graphics file below. Ignore the selected-element details.)` : '';
  const refText = refs.length ? `\n\nUseful HyperFrames catalogue techniques for this request (adapt them to this file's ids, palette and font — never paste their demo content, scripts or URLs):\n${refs.map(r => `--- ${r.name}: ${r.description} ---${r.source ? `\n${r.source}` : ''}`).join('\n\n')}` : '';
  const user = `The client's request (copied from HyperFrames Studio, with the selected element's details):\n${message}${note}${refText}\n\nCurrent ${file}:\n${html}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * @returns {Promise<{ok: boolean, file: string, attempts: number, problems: string[]}>}
 */
export async function applyDirectEdit(dir, plan, slots, message, { llm, completeFn = complete, check = checkProject, references = editReferences } = {}) {
  const target = parseStudioPrompt(message);
  if (!target) throw new Error('no File: line pointing at index.html or compositions/*.html');
  const path = safePath(dir, target.file);
  if (!existsSync(path)) throw new Error(`${target.file} does not exist in this project`);
  const original = readFileSync(path, 'utf8');
  const compId = /compositions\/(scene-\d+)\.html$/.exec(target.file)?.[1];
  const sceneIndex = compId ? Number(compId.split('-')[1]) : -1;
  const refs = compId ? await references(llm, studioInstruction(message), { completeFn }) : [];
  const messages = buildEditPrompt(target.file, original, message, plan.font, target.retargeted, refs);

  let problems = [];
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Retry without reasoning: a long thinking pass can eat the whole output budget before the file.
    const reply = await completeFn(llm.endpoint, llm.model, messages, { numPredict: 16_000, temperature: 0.3, noThink: attempt > 1, signal: AbortSignal.timeout(420_000) });
    const html = extractHtml(reply);
    problems = !html ? ['no complete HTML file in the reply']
      : compId ? staticCheck(html, compId, plan.font, null, { allowImgSrc: [...original.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]) })
      : (!html.includes('data-composition-id="main"') || !/window\.__timelines\[["']main["']\]/.test(html) ? ['the root composition (data-composition-id="main") and its timeline registration must be kept'] : []);
    if (!problems.length) {
      writeFileSync(path, html);
      const { findings } = await check(dir);
      problems = findings
        .filter(f => (compId ? belongsTo(f, sceneIndex, slots) : (f.sourceFile ?? '').endsWith('index.html')))
        .map(f => `${f.code}: ${f.message}${f.text ? ` [text: "${f.text}"]` : ''}${f.fixHint ? ` (fix: ${f.fixHint})` : ''}${f.code === 'contrast_aa_failure' ? ' — make that text darker/lighter against what is behind it' : ''}`);
      if (!problems.length) return { ok: true, file: target.file, attempts: attempt, problems: [] };
      writeFileSync(path, original); // never leave a broken edit on disk
    }
    messages.push({ role: 'assistant', content: reply || '(empty)' }, { role: 'user', content: `That edit was rejected:\n${problems.map(p => `- ${p}`).join('\n')}\nReturn the complete corrected file only.` });
  }
  return { ok: false, file: target.file, attempts: ATTEMPTS, problems };
}
