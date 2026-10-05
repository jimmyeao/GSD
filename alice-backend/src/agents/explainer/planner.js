/**
 * Explainer/promo planner — turns a brief into a validated scene plan.
 *
 * The LLM only proposes content (lines, headlines, image prompts, motion
 * ideas). Everything structural — scene count, presenter-scene budget, line
 * length, fonts, palette format — is enforced by normalizePlan() so a weak
 * or rambling local-model answer can't break the downstream pipeline.
 */

import { complete } from '../llmClient.js';
import { LAYOUTS } from './layouts.js';

export const ALLOWED_FONTS = ['Inter', 'Montserrat', 'Poppins', 'Roboto', 'Outfit', 'Playfair Display'];
export const SCENE_TYPES = ['title', 'presenter', 'narrated', 'outro'];
const MAX_SCENES = 8;
const MAX_SPEECH_WORDS = 28; // ~10s of speech — ID-LoRA/LTX drift past that
const HEX = /^#[0-9a-f]{6}$/i;

const ANTI_SECOND_GUESS = 'Think briefly, draft once, and output that draft immediately as your final answer — do not reconsider, revise, or second-guess your draft once written.';

export function buildPlannerPrompt({ brief, format, presenter, maxPresenterScenes, targetSeconds }) {
  const system = `You plan short ${format === 'promo' ? 'product promo' : 'explainer'} videos. Output ONLY a JSON object, no prose, no code fences.

Schema:
{
  "title": string,
  "palette": { "bg": "#rrggbb", "text": "#rrggbb", "accent": "#rrggbb" },
  "font": one of ${JSON.stringify(ALLOWED_FONTS)},
  "presenter": ${presenter ? '{ "description": string }  // one on-camera presenter: age, hair, clothing, setting — used to generate their portrait' : 'null'},
  "music": { "prompt": string },   // instrumental background bed: genre, instruments, mood, tempo
  "scenes": [
    {
      "type": "title" | "presenter" | "narrated" | "outro",
      "speech": string,             // exact words spoken in this scene, max ${MAX_SPEECH_WORDS} words; may be "" for title/outro
      "headline": string,           // short on-screen headline, max 7 words
      "bullets": [string],          // 0-3 short on-screen points, max 6 words each
      "layout": "bullets" | "stat" | "steps" | "compare" | "statement" | "title" | "cta",
      "stat": { "from": number, "to": number, "prefix": string, "suffix": string, "label": string },   // layout "stat" only — a number that appears in the brief
      "steps": [string],            // layout "steps" only: 2-4 short steps
      "compare": { "left_title": string, "left": [string], "right_title": string, "right": [string] },  // layout "compare" only: before vs after
      "image_prompt": string,       // narrated scenes only: an atmospheric photo of a place, object or mood (e.g. "small warehouse office at dawn, parcels on shelves") — never screens, apps, dashboards, logos or text
      "visual_idea": string,        // one sentence: how the on-screen graphics should move/appear
      "sfx": string                 // optional transition sound, e.g. "soft whoosh", or ""
    }
  ]
}

Rules:
- ${MAX_SCENES} scenes maximum; aim for about ${targetSeconds} seconds total (speech at ~2.5 words per second).
- Start with a "title" scene and end with an "outro" scene (call to action).
- ${presenter ? `Use at most ${maxPresenterScenes} "presenter" scenes (the presenter speaks to camera); use "narrated" scenes (voiceover over a background image + graphics) for the rest.` : 'Do not use "presenter" scenes — use "narrated" scenes.'}
- Speech is conversational, concrete and benefit-led. No stage directions in speech.
- Layouts: "title" for the opening card (bullets[0] = optional subtitle), "cta" for the outro (bullets[0] = button text, e.g. "Start free trial"), and for the middle scenes vary between "bullets", "stat" (one striking number), "steps" (how it works), "compare" (before vs after) and "statement" (one bold sentence as the headline; wrap 1-3 key words in *asterisks* to highlight them). Don't use the same middle layout more than twice in a row.
- palette: dark, high-contrast bg with a vivid accent; text must be readable on bg.
- Stay factual: every number, price, claim and call to action must come from the brief. Never invent statistics — only use the "stat" layout for a number that appears in the brief.
- Headlines may wrap 1-3 key words in *asterisks* to highlight them.
${ANTI_SECOND_GUESS}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Brief:\n${brief}` },
  ];
}

/** Pull the first balanced JSON object out of an LLM reply. */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function normalizeStat(st) {
  if (!st || typeof st !== 'object') return null;
  const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')));
  const to = num(st.to);
  if (!Number.isFinite(to)) return null;
  const from = Number.isFinite(num(st.from)) ? num(st.from) : 0;
  return { from, to, prefix: str(st.prefix, 6), suffix: str(st.suffix, 10), label: clampWords(str(st.label, 80), 8) };
}

/**
 * Drop a stat whose number doesn't appear in the brief — invented figures
 * are the worst failure for a product video. (No brief = no check, e.g.
 * replaying a saved plan.)
 */
export function groundedStat(stat, brief) {
  if (!stat || !brief) return stat;
  const nums = new Set((brief.replace(/,(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  return nums.has(stat.to) ? stat : null;
}

function normalizeCompare(c) {
  if (!c || typeof c !== 'object') return null;
  const list = (a) => (Array.isArray(a) ? a : []).map(x => clampWords(str(x, 60), 6)).filter(Boolean).slice(0, 3);
  const out = { left_title: str(c.left_title, 30) || 'Before', left: list(c.left), right_title: str(c.right_title, 30) || 'After', right: list(c.right) };
  return out.left.length && out.right.length ? out : null;
}

const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function clampWords(s, max) {
  const words = s.split(' ').filter(Boolean);
  return words.length <= max ? s : `${words.slice(0, max).join(' ').replace(/[,;:]$/, '')}.`;
}

/**
 * Validate + repair a raw plan. Throws only when nothing usable is left.
 * @param {object} raw
 * @param {{presenter: boolean, maxPresenterScenes: number}} opts
 */
export function normalizePlan(raw, { presenter, maxPresenterScenes, brief = '' }) {
  if (!raw || typeof raw !== 'object') throw new Error('plan is not an object');
  const palette = raw.palette ?? {};
  const plan = {
    title: str(raw.title, 120) || 'Untitled',
    palette: {
      bg: HEX.test(palette.bg) ? palette.bg : '#0b1020',
      text: HEX.test(palette.text) ? palette.text : '#f5f7ff',
      accent: HEX.test(palette.accent) ? palette.accent : '#4f8cff',
    },
    font: ALLOWED_FONTS.includes(raw.font) ? raw.font : 'Inter',
    presenter: null,
    music: { prompt: str(raw.music?.prompt, 300) || 'modern corporate, light electronic, soft synth pads, steady beat, 100 BPM, instrumental' },
    scenes: [],
  };

  const wantPresenter = presenter && maxPresenterScenes > 0;
  const presenterDesc = str(raw.presenter?.description, 400);
  let presenterCount = 0;

  for (const s of Array.isArray(raw.scenes) ? raw.scenes : []) {
    if (plan.scenes.length >= MAX_SCENES) break;
    if (!s || typeof s !== 'object') continue;
    let type = SCENE_TYPES.includes(s.type) ? s.type : 'narrated';
    if (type === 'presenter' && (!wantPresenter || !presenterDesc || presenterCount >= maxPresenterScenes)) type = 'narrated';
    const speech = clampWords(str(s.speech, 400), MAX_SPEECH_WORDS);
    // presenter/narrated scenes exist to carry speech — skip empty ones
    if ((type === 'presenter' || type === 'narrated') && !speech) continue;
    if (type === 'presenter') presenterCount++;
    plan.scenes.push({
      type,
      layout: LAYOUTS.includes(s.layout) ? s.layout : '',
      stat: groundedStat(normalizeStat(s.stat), brief),
      steps: (Array.isArray(s.steps) ? s.steps : []).map(x => clampWords(str(x, 60), 6).replace(/\.$/, '')).filter(Boolean).slice(0, 4),
      compare: normalizeCompare(s.compare),
      speech,
      headline: clampWords(str(s.headline, 80), 7).replace(/\.$/, ''),
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).map(b => clampWords(str(b, 60), 6).replace(/\.$/, '')).filter(Boolean).slice(0, 3),
      image_prompt: type === 'narrated' ? (str(s.image_prompt, 400) || `${str(s.headline, 80)}, cinematic photo, soft light`) : '',
      visual_idea: str(s.visual_idea, 240),
      sfx: str(s.sfx, 80),
    });
  }

  if (!plan.scenes.some(s => s.speech)) throw new Error('plan has no spoken scenes');
  if (plan.scenes[0].type !== 'title') plan.scenes.unshift({ type: 'title', layout: 'title', stat: null, steps: [], compare: null, speech: '', headline: plan.title, bullets: [], image_prompt: '', visual_idea: 'headline scales up and fades in', sfx: 'soft whoosh' });
  if (plan.scenes.at(-1).type !== 'outro') plan.scenes.push({ type: 'outro', layout: 'cta', stat: null, steps: [], compare: null, speech: '', headline: plan.title, bullets: [], image_prompt: '', visual_idea: 'headline fades in', sfx: '' });
  if (presenterCount > 0) plan.presenter = { description: presenterDesc };
  return plan;
}

/**
 * Ask the LLM for a plan, retrying once with the parse error if the first
 * answer isn't usable JSON.
 */
export async function planExplainer(llm, opts, { completeFn = complete } = {}) {
  const messages = buildPlannerPrompt(opts);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await completeFn(llm.endpoint, llm.model, messages, { numPredict: 8000, temperature: 0.6, signal: AbortSignal.timeout(300_000) });
    try {
      return normalizePlan(extractJson(reply), opts);
    } catch (err) {
      lastErr = err;
      messages.push({ role: 'assistant', content: reply || '(empty)' }, { role: 'user', content: `That was not a usable plan (${err.message}). Reply with ONLY the JSON object.` });
    }
  }
  throw new Error(`planner failed: ${lastErr.message}`);
}
