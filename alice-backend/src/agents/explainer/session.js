/**
 * Conversational explainer production — the chat ExplainerAgent's state
 * machine, one session per conversation (state persisted in the project dir
 * data/explainers/conv-<convId>/state.json, so it survives restarts).
 *
 *   (new) ──brief──▶ questions ──answers──▶ storyboard ⇄ (feedback → revise)
 *                                              │ "approve"
 *                                              ▼
 *                                          rendering ──▶ done ──feedback──▶ storyboard …
 *
 * - New brief: read its links, classify attachments, ask the few questions
 *   that matter (skipped if the LLM has none).
 * - Storyboard: scene table + a ~1 min draft animatic (real voice/layouts/
 *   attached media; presenter + AI backgrounds as placeholders).
 * - Approve → full render. Later feedback revises the plan again; unchanged
 *   media is reused (content-hashed assets).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { askQuestions, planExplainer, revisePlan } from './planner.js';
import { projectDir, prepareContext, addImages, makeAnimatic, produceVideo, withLLM, explainerLLM } from './pipeline.js';
import { assertRuntime } from './hyperframesCli.js';

const APPROVE = /^\s*(approve[d]?|go( ahead)?|render( it)?|looks good|lgtm|yes[,.!]?\s*(render|go|do it|approve)?|ship it|perfect|do it|make it|ok(ay)?[,.!]?\s*(go|render)?)\s*[.!]*\s*$/i;
const SKIP_QUESTIONS = /^\s*(use (your )?defaults?|go with (your )?defaults?|skip|no questions|just do it)\b/i;
const locks = new Set();

export const isApproval = (text) => APPROVE.test(text);

function load(dir) {
  const f = join(dir, 'state.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
function save(dir, state) {
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—';

/** Scene-by-scene storyboard as a markdown table. */
export function storyboardMarkdown(plan, slots, ctx) {
  const total = slots.length ? slots.at(-1).start + slots.at(-1).duration : 0;
  const mediaName = (id) => ctx.images?.find(i => i.id === id)?.name ?? id;
  const rows = plan.scenes.map((s, i) => {
    const visual = s.type === 'presenter' ? '🎤 presenter on camera'
      : s.media ? `🖼 your image: ${mediaName(s.media)}`
      : s.type === 'narrated' ? `AI background: ${s.image_prompt.slice(0, 70)}`
      : 'title card';
    const onScreen = [s.headline, ...(s.layout === 'steps' && s.steps.length ? s.steps : s.bullets)].filter(Boolean).join(' · ');
    return `| ${i + 1} | ${slots[i].start.toFixed(1)}s | ${cell(s.layout || s.type)} | ${cell(onScreen)} | ${cell(visual)} | ${cell(s.speech)} |`;
  });
  const lines = [
    `### Storyboard — ${plan.title}`,
    `~${Math.round(total)}s · ${plan.scenes.length} scenes · font ${plan.font} · palette ${plan.palette.bg} / ${plan.palette.accent}`,
    plan.presenter ? `**Presenter:** ${plan.presenter.description}` : '**Presenter:** none (voiceover only)',
    `**Music:** ${plan.music.prompt}`,
    '',
    '| # | At | Layout | On screen | Visual | Voiceover |',
    '|---|---|---|---|---|---|',
    ...rows,
  ];
  return lines.join('\n');
}

/**
 * Handle one chat turn for the explainer session in `convId`.
 * @param {object} turn  { convId, message, images: [{name,dataUrl}], opts (validated, first turn only) }
 * @param {object} ui    { say(markdown), progress(msg), saveVideo(file, title) → url }
 */
export async function handleExplainerTurn({ convId, message, images = [], opts }, ui) {
  assertRuntime();
  // convId is a DB row id; anything else must never become a path component.
  if (!/^\d{1,12}$/.test(String(convId))) throw new Error('invalid conversation id');
  const id = `conv-${convId}`;
  if (locks.has(id)) {
    ui.say('I\'m still working on the previous step for this video — I\'ll post here when it\'s done.');
    return;
  }
  locks.add(id);
  try {
    const dir = projectDir(id);
    let state = load(dir);
    const llm = explainerLLM();
    const progress = (m) => ui.progress(m);

    // ── New session: research + questions ───────────────────────────
    if (!state) {
      state = { stage: 'new', opts: { ...opts, images: undefined }, brief: message, ctx: null, plan: null, answers: '', seed: Math.floor(Math.random() * 2 ** 31), renders: 0 };
      state.ctx = await prepareContext(dir, { brief: message, images }, progress);
      const planCtx = { ...state.opts, ...state.ctx };
      const { summary, questions } = await withLLM(() => askQuestions(llm, planCtx), { onProgress: progress });
      if (questions.length) {
        state.stage = 'questions';
        state.questions = questions;
        save(dir, state);
        ui.say(`${summary ? `**My understanding:** ${summary}\n\n` : ''}A few questions before I storyboard it:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nAnswer any you like (anything you skip, I'll use the suggestion in brackets) — or reply **use defaults**.`);
        return;
      }
      state.stage = 'questions'; // fall through straight to the storyboard
      message = '';
    }

    // New attachments can arrive on any turn.
    if (images.length) {
      progress(`Looking at ${images.length} new image(s)…`);
      state.ctx.images = [...state.ctx.images, ...await addImages(dir, images, state.ctx.images)];
    }

    if (state.stage === 'rendering') {
      ui.say('The full render is already running for this video — it will appear here when it finishes.');
      return;
    }

    const planCtx = () => ({ ...state.opts, ...state.ctx, answers: state.answers });

    // ── Answers → first storyboard ──────────────────────────────────
    if (state.stage === 'questions') {
      state.answers = message && !SKIP_QUESTIONS.test(message) ? message : 'No answers — use your suggested defaults.';
      progress('Writing the storyboard…');
      state.plan = await withLLM(() => planExplainer(llm, planCtx()), { onProgress: progress });
      return await showStoryboard(dir, state, ui, progress);
    }

    // ── Storyboard / done: approve or revise ────────────────────────
    if (state.stage === 'storyboard' && isApproval(message)) {
      state.stage = 'rendering';
      save(dir, state);
      const withPresenter = state.plan.scenes.some(s => s.type === 'presenter');
      ui.say(`Approved — rendering the full video now (${withPresenter ? 'presenter clips take ~6 min each, so roughly 10-25 minutes' : 'about 4-6 minutes'}).\n\n`);
      try {
        const out = await produceVideo(dir, structuredClone(state.plan), state.ctx, { voice: state.opts.voice, seed: state.seed, creative: state.opts.creative }, progress);
        state.stage = 'done';
        state.renders += 1;
        state.portraitFile = out.portraitFile;
        save(dir, state);
        const url = await ui.saveVideo(out.file, state.plan.title);
        const warn = out.warnings.length ? `\n\n_Notes: ${out.warnings.join('; ')}_` : '';
        ui.say(`\n**${state.plan.title}** is ready.${warn}\n\n[Download video](${url})\n\n<video controls width="640" src="${url}"></video>\n\nWant changes? Tell me what to adjust and I'll update the storyboard — unchanged scenes are reused.`);
      } catch (err) {
        state.stage = 'storyboard';
        save(dir, state);
        throw err;
      }
      return;
    }

    progress('Revising the storyboard…');
    state.plan = await withLLM(() => revisePlan(llm, state.plan, message, planCtx()), { onProgress: progress });
    return await showStoryboard(dir, state, ui, progress);
  } finally {
    locks.delete(id);
  }
}

async function showStoryboard(dir, state, ui, progress) {
  const anim = await makeAnimatic(dir, state.plan, state.ctx, { voice: state.opts.voice, portraitFile: state.portraitFile }, progress);
  state.stage = 'storyboard';
  save(dir, state);
  const url = await ui.saveVideo(anim.file, `Storyboard: ${state.plan.title}`);
  ui.say(`${storyboardMarkdown(state.plan, anim.slots, state.ctx)}\n\n**Animatic** (draft: real voiceover and layouts${state.plan.presenter && !state.portraitFile ? '; presenter shown as a placeholder' : ''}; AI backgrounds not generated yet):\n\n<video controls width="640" src="${url}"></video>\n\nReply **approve** to render the full video, or tell me what to change.`);
}
