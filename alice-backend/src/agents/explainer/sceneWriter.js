/**
 * LLM-written scene graphics for the explainer pipeline.
 *
 * Each scene gets its own HyperFrames sub-composition (a transparent
 * overlay: headline, bullets, shapes, motion), mounted at its scene's safe
 * area. The model writes the whole file; we gate it with cheap static checks
 * + `hyperframes check` (lint, runtime console errors, layout overlap/
 * overflow, contrast — in a real browser), feed the exact findings back for
 * up to MAX_FIX_ROUNDS repairs, and fall back to the
 * deterministic template (timeline.js fallbackSceneHtml) for any scene that
 * still fails — so a weak generation can only make a scene plainer, never
 * break the render.
 *
 * All scenes are generated concurrently (vLLM batches them); one `check`
 * per round then covers every candidate scene at once.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { complete } from '../llmClient.js';
import { ALLOWED_FONTS } from './planner.js';
import { SAFE_AREAS, fallbackSceneHtml } from './timeline.js';
import { resolveStyle } from './styles.js';

const MAX_FIX_ROUNDS = 2;
const ANTI_SECOND_GUESS = 'Think briefly, write the file once, and output it immediately — do not reconsider, revise, or second-guess it once written.';

const RULES = `You write ONE HyperFrames sub-composition file: a transparent motion-graphics overlay for one scene of a video. Your canvas is CANVAS_W x CANVAS_H pixels (it is placed in a safe region of the 1920x1080 frame for you). Output ONLY the HTML file, no prose, no code fences.

Exact file shape (everything inside <template>):
<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body><template>
<style>
  #root { position: absolute; inset: 0; }   /* style the root by #root, never by class */
  /* your styles: give elements ids like COMP_ID-title, COMP_ID-b1 and select them by
     those ids (#COMP_ID-title) or by classes. NO element has the id "COMP_ID" itself,
     so never write selectors like "#COMP_ID .x". */
</style>
<div id="root" data-composition-id="COMP_ID" data-width="CANVAS_W" data-height="CANVAS_H">
  <!-- your markup -->
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  // your tweens, positioned with absolute times in seconds (third argument)
  window.__timelines["COMP_ID"] = tl;
</script>
</template></body></html>

Hard rules (violations are rejected):
- gsap is already loaded. Build exactly one paused timeline and register it as shown. No other scripts, no imports.
- Every tween starts within the scene duration; the last tween ends before it.
- Set initial states in the tween (gsap.fromTo / from), never with a CSS transform on the same property.
- Center with flexbox or inset, not translate(-50%,-50%).
- No <img>, <video>, <audio>, <iframe>, <canvas>, no url(), no http links — text, divs, inline SVG and CSS gradients only.
- No Math.random, Date, setTimeout, setInterval, requestAnimationFrame, repeat: -1.
- Core gsap only: NO plugins (no text: tweens, SplitText, TextPlugin, ScrambleText, MotionPath, DrawSVG, registerPlugin). To animate words, wrap each word in its own <span> and tween the spans. For a counting number, tween a plain object and write Math.round(value) into textContent in onUpdate.
- Text blocks must never overlap each other: give each block its own position (stack them with flexbox column + gap, or distinct top values).
- No <br>. Elements you transform must be block or inline-block.
- No emoji or emoticons anywhere. For icons, draw simple shapes with divs/CSS or inline SVG.
- Every #id you use in CSS or in gsap selectors must exist on an element in your markup.
- font-family must be the given font (plus a generic fallback). No other named fonts.
- Background stays transparent (the video/image underneath must show through).
- Keep everything inside the CANVAS_W x CANVAS_H canvas; text must wrap within it (set max-width), never overflow.
- Text must be large and readable: headlines 64-120px, body 36-52px.
${ANTI_SECOND_GUESS}`;

export function buildScenePrompt(compId, scene, { palette, font, duration, words, logoFile }) {
  const area = SAFE_AREAS[scene.type] ?? SAFE_AREAS.narrated;
  const cues = (words ?? []).slice(0, 60).map(w => `${w.start.toFixed(2)}s "${w.text}"`).join(', ');
  const context = {
    title: 'a full-screen title card over a dark gradient',
    outro: 'the closing call-to-action card over a dark gradient',
    narrated: 'a voiceover scene over a darkened full-screen photo',
    presenter: 'a narrow text column beside the presenter, who is on camera to the right — keep it compact and left-aligned',
  }[scene.type];
  const user = `COMP_ID: ${compId}
Scene type: ${scene.type} (${context})
Duration: ${duration.toFixed(2)} seconds
Canvas: ${area.width} x ${area.height}
Font: "${font}"
Palette: text ${palette.text}, accent ${palette.accent}, background ${palette.bg}
Headline: ${scene.headline || '(none)'}
Bullets: ${scene.bullets.length ? scene.bullets.map(b => `"${b}"`).join(', ') : '(none)'}
Motion idea: ${scene.visual_idea || 'clean, confident entrances'}
${cues ? `Spoken word timings (scene-local) — reveal each bullet near the word it relates to: ${cues}` : ''}${logoFile ? `
Brand logo: include it as <img id="${compId}-logo" src="${logoFile}" alt=""> — the only image allowed. Give it a CSS height of 90-140px with width auto (never stretch it), place it prominently above or beside the headline, and animate it in.` : ''}`;
  const system = RULES.replaceAll('COMP_ID', compId).replaceAll('CANVAS_W', String(area.width)).replaceAll('CANVAS_H', String(area.height));
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Strip fences/prose around the file the model returned. */
export function extractHtml(reply) {
  if (!reply) return '';
  const text = reply.replace(/```(?:html)?/gi, '');
  const start = text.search(/<!doctype html|<html/i);
  const end = text.toLowerCase().lastIndexOf('</html>');
  return start >= 0 && end > start ? text.slice(start, end + 7).trim() : '';
}

/**
 * Cheap pre-check rules that lint/check don't (reliably) enforce.
 * Returns a list of human-readable problems ([] = pass).
 */
export function staticCheck(html, compId, font, scene = null, { logoFile, allowImgSrc = [] } = {}) {
  const problems = [];
  if (!html) return ['no HTML file found in the reply'];
  if (scene) {
    // Every piece of planned on-screen text must actually be in the file.
    const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').toLowerCase();
    const missing = [scene.headline?.replace(/\*/g, ''), ...(scene.bullets ?? [])]
      .filter(Boolean).filter(t => !visible.includes(t.toLowerCase().replace(/\s+/g, ' ').trim()));
    if (missing.length) problems.push(`missing on-screen text (must appear verbatim as visible text): ${missing.map(t => `"${t}"`).join(', ')}`);
  }
  if (!/<template>[\s\S]*<\/template>/i.test(html)) problems.push('everything must be inside <template>…</template>');
  if (!html.includes(`data-composition-id="${compId}"`)) problems.push(`root must have data-composition-id="${compId}"`);
  if (!new RegExp(`window\\.__timelines\\[["']${compId}["']\\]\\s*=`).test(html)) problems.push(`register the timeline as window.__timelines["${compId}"] = tl`);
  // The brand logo is the one image allowed (title/outro), and then required.
  const logoTag = logoFile ? new RegExp(`<img\\b[^>]*\\bsrc=["']${logoFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'gi') : null;
  if (logoTag && !logoTag.test(html)) problems.push(`include the logo exactly as <img id="${compId}-logo" src="${logoFile}" alt=""> (sized with CSS, never stretched)`);
  // allowImgSrc: images the file already had (a direct edit of a screenshot scene keeps its screenshot).
  const allowed = new Set([...allowImgSrc, ...(logoFile ? [logoFile] : [])]);
  const stripped = html.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (tag, src) => (allowed.has(src) ? '' : tag));
  if (/<(img|video|audio|iframe|canvas)\b/i.test(stripped)) problems.push(allowed.size ? `no <img>/<video>/<audio>/<iframe>/<canvas> elements other than ${[...allowed].map(a => `<img src="${a}">`).join(', ')}` : 'no <img>/<video>/<audio>/<iframe>/<canvas> elements');
  if (/url\(|https?:\/\//i.test(html)) problems.push('no url() or http(s) links');
  if (/Math\.random|Date\.now|new Date|setTimeout|setInterval|requestAnimationFrame|repeat:\s*-1/.test(html)) problems.push('no Math.random/Date/timers/infinite repeats');
  if (/<br\b/i.test(html)) problems.push('no <br>');
  if (/\p{Extended_Pictographic}/u.test(html)) problems.push('no emoji — draw icons with CSS shapes or inline SVG');
  // Selectors pointing at ids that don't exist silently style/animate nothing
  // (a real scene targeted "#scene-6 .headline" → all text rendered unstyled).
  const markup = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  // (?<![\w-]) so data-composition-id="…" doesn't count as an element id
  const ids = new Set([...markup.matchAll(/(?<![\w-])id=["']([^"']+)["']/g)].map(m => m[1]));
  const css = (html.match(/<style[\s\S]*?<\/style>/gi) ?? []).join(' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/#[0-9a-f]{3,8}\b(?=\s*[;,)}!\s])/gi, ' ');
  const js = (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).join(' ');
  const referenced = new Set([
    ...[...css.matchAll(/#([A-Za-z_][\w-]*)/g)].map(m => m[1]),
    ...[...js.matchAll(/["'`]#([A-Za-z_][\w-]*)/g)].map(m => m[1]),
    ...[...js.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]),
  ]);
  const missing = [...referenced].filter(id => !ids.has(id));
  if (missing.length) problems.push(`these ids are used in CSS/JS but no element has them: ${missing.map(m => `#${m}`).join(', ')}${missing.includes(compId) ? ` — nothing has id "${compId}"; style elements by their own ids or classes` : ''}`);
  if (/<script[^>]+src=/i.test(html)) problems.push('no external scripts');
  if (/registerPlugin|SplitText|TextPlugin|ScrambleText|MotionPath|DrawSVG|MorphSVG|\btext\s*:\s*["'`{]/.test(html)) problems.push('no gsap plugins (no text: tweens) — wrap words in spans, or tween a plain object and set textContent in onUpdate');
  for (const m of html.matchAll(/font-family\s*:\s*([^;}"]*(?:"[^"]*"[^;}"]*)*)/gi)) {
    for (const f of m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))) {
      if (f && !/^(sans-serif|serif|monospace|system-ui|inherit)$/i.test(f) && f !== font && !ALLOWED_FONTS.includes(f)) {
        problems.push(`font "${f}" is not allowed — use "${font}"`);
      }
    }
  }
  return problems;
}

/**
 * Does a check finding belong to scene i? By source file when it names a
 * scene file; otherwise (runtime console messages report the root file) by
 * the sample time falling inside the scene's slot.
 */
export function belongsTo(f, i, slots) {
  const m = /scene-(\d+)\.html$/.exec(f.sourceFile ?? '');
  if (m) return Number(m[1]) === i;
  if (f.stage !== 'runtime' || !Number.isFinite(f.time) || !slots?.[i]) return false;
  return f.time >= slots[i].start && f.time < slots[i].start + slots[i].duration;
}

function fixMessage(problems) {
  return `That file was rejected:\n${problems.map(p => `- ${p}`).join('\n')}\nReturn the complete corrected file only.`;
}

/**
 * Write compositions/scene-N.html for every scene.
 * @param {string} projectDir
 * @param {object} plan
 * @param {{duration:number, words?:object[], mediaFile?:string, logoFile?:string}[]} sceneInfo per scene
 * @param {{llm:{endpoint,model}, check:(dir)=>Promise<{findings}>, slots:{start,duration}[], onProgress?:fn, completeFn?:fn}} deps
 * @returns {Promise<{index:number, source:'llm'|'fallback', rounds:number}[]>}
 */
export async function writeScenes(projectDir, plan, sceneInfo, { llm, check, slots, onProgress = () => {}, completeFn = complete }) {
  const { palette, font } = plan;
  const style = resolveStyle(plan);
  const states = plan.scenes.map((scene, i) => ({
    index: i, compId: `scene-${i}`, scene, rounds: 0, done: false, source: 'fallback',
    messages: buildScenePrompt(`scene-${i}`, scene, { palette, font, duration: sceneInfo[i].duration, words: sceneInfo[i].words, logoFile: sceneInfo[i].logoFile }),
    html: '',
  }));
  const file = (s) => join(projectDir, 'compositions', `${s.compId}.html`);
  const fallback = (s) => {
    const { duration, words, mediaFile, mediaSize, mediaFocus, logoFile } = sceneInfo[s.index];
    return fallbackSceneHtml(s.compId, s.scene, { style, palette, font, duration, words, mediaFile, mediaSize, mediaFocus, logoFile });
  };
  const ask = async (s) => {
    try {
      const reply = await completeFn(llm.endpoint, llm.model, s.messages, { numPredict: 12_000, temperature: 0.5, signal: AbortSignal.timeout(420_000) });
      s.messages.push({ role: 'assistant', content: reply || '(empty)' });
      s.html = extractHtml(reply);
    } catch (err) {
      s.html = '';
      s.llmError = err.message;
    }
  };

  // Every scene starts as the template, so the project always checks/renders.
  for (const s of states) writeFileSync(file(s), fallback(s));

  // Scenes showing an attached screenshot keep the showcase template: the
  // LLM never sees the image, so its version would drop the screenshot.
  let pending = states.filter(s => !sceneInfo[s.index].mediaFile);
  for (let round = 0; round <= MAX_FIX_ROUNDS && pending.length; round++) {
    onProgress(round === 0 ? `Writing graphics for ${pending.length} scene(s)…` : `Fixing ${pending.length} scene(s) (round ${round})…`);
    await Promise.all(pending.map(ask));

    const next = [];
    const candidates = [];
    for (const s of pending) {
      s.rounds = round + 1;
      s.problems = staticCheck(s.html, s.compId, font, s.scene, { logoFile: sceneInfo[s.index].logoFile });
      if (s.problems.length) writeFileSync(file(s), fallback(s));
      else { writeFileSync(file(s), s.html); candidates.push(s); }
    }
    // One browser check per round covers every candidate scene at once.
    if (candidates.length) {
      const { findings } = await check(projectDir);
      for (const s of candidates) {
        s.problems = findings.filter(f => belongsTo(f, s.index, slots)).map(f => `${f.code}: ${f.message}${f.text ? ` [text: "${f.text}"]` : ''}${f.fixHint ? ` (fix: ${f.fixHint})` : ''}`);
      }
    }
    for (const s of pending) {
      if (s.problems.length) {
        writeFileSync(file(s), fallback(s));
        if (s.llmError) {
          // Transient LLM failure (e.g. still restarting after ComfyUI) —
          // ask again next round with the same messages, not a fix request.
          delete s.llmError;
          next.push(s);
        } else {
          s.messages.push({ role: 'user', content: fixMessage(s.problems) });
          next.push(s);
        }
      } else {
        s.done = true;
        s.source = 'llm';
      }
    }
    pending = next;
  }
  return states.map(s => ({ index: s.index, source: s.source, rounds: s.rounds }));
}
