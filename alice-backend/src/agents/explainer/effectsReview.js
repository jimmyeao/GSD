/**
 * Effects review: after the storyboard is written, the LLM reviews the
 * curated HyperFrames catalogue (catalog.js) against this video's style and
 * scenes and picks what's appropriate per scene — a transition into it and
 * up to two effects — plus an optional whole-video overlay. Picks are then
 * validated so every one can actually be rendered:
 *   - transitions and overlays must be native (they live in the root timeline)
 *   - callouts only on scenes showing a screenshot; cta on the outro; logo on
 *     title/outro
 *   - non-native ("adapted") items only on scenes Qwen writes itself
 * The picks are shown in the storyboard, so the client can ask for others.
 */

import { complete } from '../llmClient.js';
import { loadCatalog, curate, menuText } from './catalog.js';
import { STYLES } from './styles.js';
import { NATIVE } from './catalog.js';

// Alternatives used when the review repeats a transition back to back.
const ENERGETIC = new Set(['boldpop', 'neon', 'techgrid']);
const POOL = { calm: ['fade-through', 'iris-reveal', 'light-leak', 'directional-wipe'], energetic: ['whip-pan-cut', 'zoom-through-transition', 'flash-through-white', 'page-slide'] };

const MAX_ITEMS = 2;

/** Which scenes Qwen writes (creative mode, no screenshot/footage) vs templates. */
export function sceneWriters(plan, creative) {
  return plan.scenes.map(s => (creative && !s.media ? 'custom' : 'template'));
}

export function buildReviewPrompt(plan, menu, { creative, feedback = '', previous = null }) {
  const writers = sceneWriters(plan, creative);
  const style = STYLES[plan.style];
  const system = `You are the motion designer for a short product video built with HyperFrames. Review the effects catalogue below and choose what is appropriate for each scene — effects should support the message, suit the style, and vary across the video without becoming noisy. Output ONLY JSON, no prose:
{"overlay": "" | "vignette" | "grain-overlay", "scenes": [{"transition": string, "items": [string], "why": string}]}   // one entry per scene, in order

Rules:
- "transition" = how the scene is entered: a [native] item from "## transition" ("" for scene 1). Match the style's energy (calm/premium → fade-through, iris-reveal, light-leak; energetic → whip-pan-cut, flash-through-white, zoom-through-transition). Use at least three different transitions across the video and never the same one more than twice in a row.
- "items" = at most ${MAX_ITEMS} more effects for the scene, by exact name:
  - scenes marked "template" can only use [native] items;
  - scenes marked "custom" may also use any other catalogue item that fits the scene's content (the scene is written from that item's real source);
  - callout items (hw-callout-circle, outline-draw, yt-feather-highlight) only on scenes that show a screenshot;
  - cta items only on the outro; logo items only on the title or outro.
- Give the headline treatments (per-word-rise, blur-in, text-shimmer, marker-highlight) to a few scenes, not all.
- "why": a few words on why it fits.
- overlay: "grain-overlay" for warm/editorial/film looks, "vignette" for dramatic dark looks, "" otherwise.
${previous ? '- Keep the current choices unless the client feedback asks for a change or the scene itself changed.\n' : ''}- Think briefly and answer once.

# Catalogue
${menuText(menu)}`;
  const scenes = plan.scenes.map((s, i) => `${i + 1}. ${s.type} | layout ${s.layout} | ${writers[i]}${s.media ? ' | shows a screenshot/footage' : ''} | "${s.headline}"${s.bullets?.length ? ` — ${s.bullets.join('; ')}` : ''}`).join('\n');
  const user = `Video: "${plan.title}" — style "${plan.style}" (${style?.description ?? ''}), accent ${plan.palette?.accent}
Scenes:
${scenes}${previous ? `\n\nCurrent choices:\n${JSON.stringify(previous)}` : ''}${feedback ? `\n\nClient feedback: ${feedback}` : ''}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function parseJson(reply) {
  const t = String(reply ?? '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/** Validate raw picks against the menu and the scenes. Returns { overlay, scenes: [{transition, items, why}] }. */
export function normalizeEffects(raw, plan, menu, { creative }) {
  const byName = new Map(menu.map(m => [m.name, m]));
  const writers = sceneWriters(plan, creative);
  const last = plan.scenes.length - 1;
  const overlay = byName.get(raw?.overlay)?.role === 'overlay' ? raw.overlay : '';
  const pool = POOL[ENERGETIC.has(plan.style) ? 'energetic' : 'calm'];
  let prevNative = null;
  const scenes = plan.scenes.map((s, i) => {
    const r = Array.isArray(raw?.scenes) ? raw.scenes[i] ?? {} : {};
    const tr = byName.get(r.transition);
    let transition = i > 0 && tr?.role === 'transition' && tr.native ? r.transition : '';
    // Never the same transition twice in a row (aliases count as the same).
    if (transition && NATIVE[transition]?.id === prevNative) {
      transition = pool.find(n => NATIVE[n].id !== prevNative && byName.has(n)) ?? '';
    }
    if (i > 0) prevNative = transition ? NATIVE[transition].id : null;
    const items = [];
    for (const name of Array.isArray(r.items) ? r.items : []) {
      const m = byName.get(name);
      if (!m || items.includes(name) || items.length >= MAX_ITEMS) continue;
      if (m.role === 'transition' || m.role === 'overlay') continue;
      if (!m.native && writers[i] !== 'custom') continue;
      if (m.role === 'callout' && !s.media) continue;
      if (m.role === 'cta' && i !== last) continue;
      if (m.role === 'logo' && i !== 0 && i !== last) continue;
      items.push(name);
    }
    return { transition, items, why: String(r.why ?? '').slice(0, 120) };
  });
  return { overlay, scenes };
}

/**
 * Review the catalogue for this plan and attach the picks (scene.effects,
 * plan.effects). Never throws: on any failure the plan keeps its style's
 * default motion.
 */
export async function reviewEffects(llm, plan, { creative = false, feedback = '', previous = null, completeFn = complete, catalog } = {}) {
  try {
    const menu = curate(catalog ?? await loadCatalog());
    if (!menu.length) return plan;
    const reply = await completeFn(llm.endpoint, llm.model, buildReviewPrompt(plan, menu, { creative, feedback, previous }),
      { numPredict: 4000, temperature: 0.5, noThink: true, signal: AbortSignal.timeout(180_000) });
    const fx = normalizeEffects(parseJson(reply), plan, menu, { creative });
    plan.scenes.forEach((s, i) => { s.effects = fx.scenes[i]; });
    plan.effects = { overlay: fx.overlay };
  } catch (err) {
    console.warn(`[explainer] effects review skipped: ${err.message}`);
  }
  return plan;
}

/** Current picks in the shape the review prompt shows back. */
export function currentEffects(plan) {
  if (!plan?.scenes?.some(s => s.effects)) return null;
  return { overlay: plan.effects?.overlay ?? '', scenes: plan.scenes.map(s => ({ headline: s.headline, ...(s.effects ?? {}) })) };
}
