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

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { askQuestions, planExplainer, revisePlan } from './planner.js';
import { projectDir, prepareContext, addImages, makeAnimatic, produceVideo, withLLM, explainerLLM, EXPLAINERS_DIR } from './pipeline.js';
import { assertRuntime, renderProject } from './hyperframesCli.js';
import { parseStudioPrompt, applyDirectEdit, studioInstruction } from './directEdit.js';
import { FOCUS_REQUEST, applyFocusEdit } from './focusEdit.js';
import { checkProject } from './hyperframesCli.js';
import { layoutTimeline } from './timeline.js';
import { STYLES, STYLE_IDS } from './styles.js';
import { reviewEffects, currentEffects } from './effectsReview.js';

const APPROVE = /^\s*(approve[d]?|go( ahead)?|render( it)?|looks good|lgtm|yes[,.!]?\s*(render|go|do it|approve)?|ship it|perfect|do it|make it|ok(ay)?[,.!]?\s*(go|render)?)\s*[.!]*\s*$/i;
const RENDER_EDITS = /\b(render|use|keep) (my |the )?(studio |manual )?edits\b|\brender (the )?studio( version)?\b|\brender (it )?as[- ]is\b/i;
const OPEN_STUDIO = /^\s*(please\s+)?(open|edit|launch|show|give me)(\s+(it|this|the video))?\s+(in\s+)?(the\s+)?(an?\s+)?(new\s+)?(hyperframes\s+)?(studio|editor|edit link|studio link|editor link)(\s+link)?(\s+again)?\s*(please)?\s*[.!?]*\s*$|^\s*(studio|editor)\s*[.!?]*\s*$/i;
const OVERRIDE_EDITS = /\banyway\b|\bdiscard (my )?edits\b/i;
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

/** Newest mtime of the files Studio edits (composition HTML). */
export function compositionMtime(dir) {
  const files = [join(dir, 'index.html'), ...readdirSync(join(dir, 'compositions')).filter(f => f.endsWith('.html')).map(f => join(dir, 'compositions', f))];
  return Math.max(0, ...files.filter(existsSync).map(f => statSync(f).mtimeMs));
}
const hasStudioEdits = (dir, state) => !!state.handEdited || (state.composedAt && compositionMtime(dir) > state.composedAt + 2000);

/** Chat commands — these must never be mistaken for a new video brief. */
const isCommand = (m) => OPEN_STUDIO.test(m) || RENDER_EDITS.test(m) || APPROVE.test(m) || !!parseStudioPrompt(m);

/**
 * Conversations from before the conversational flow (2026-10-05) rendered
 * into a random-UUID project and kept no session state. Adopt that project
 * as this conversation's session so Studio/edits/revisions work there too.
 * @param {string|null} legacyDirName  data/explainers/<uuid> found via the conversation's asset
 */
export function adoptLegacyProject(convId, legacyDirName) {
  if (!legacyDirName || !/^[0-9a-f-]{36}$/.test(legacyDirName)) return null;
  const legacy = join(EXPLAINERS_DIR, legacyDirName);
  if (!existsSync(join(legacy, 'plan.json')) || !existsSync(join(legacy, 'out.mp4'))) return null;
  const target = join(EXPLAINERS_DIR, `conv-${convId}`);
  if (existsSync(join(target, 'out.mp4'))) return null;
  rmSync(target, { recursive: true, force: true }); // only ever a stub (no video) at this point
  renameSync(legacy, target);
  const plan = JSON.parse(readFileSync(join(target, 'plan.json'), 'utf8'));
  for (const s of plan.scenes) { s.media ??= ''; s.layout ??= ''; }
  const state = {
    stage: 'done', adoptedFrom: legacyDirName,
    opts: { format: 'explainer', presenter: plan.scenes.some(s => s.type === 'presenter'), maxPresenterScenes: 3, targetSeconds: 45, creative: false },
    brief: plan.title, ctx: { brief: plan.title, sourceText: '', sources: [], images: [] },
    plan, answers: '', seed: Math.floor(Math.random() * 2 ** 31), renders: 1, composedAt: compositionMtime(target),
  };
  writeFileSync(join(target, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—';

/** Scene-by-scene storyboard as a markdown table. */
export function storyboardMarkdown(plan, slots, ctx) {
  const total = slots.length ? slots.at(-1).start + slots.at(-1).duration : 0;
  const mediaName = (id) => ctx.images?.find(i => i.id === id)?.name ?? id;
  const rows = plan.scenes.map((s, i) => {
    const visual = s.type === 'presenter' ? '🎤 presenter on camera'
      : s.media ? (ctx.images?.find(i => i.id === s.media)?.kind === 'video' ? `🎬 site demo footage: ${mediaName(s.media)}` : `🖼 ${String(mediaName(s.media)).startsWith('site: ') ? 'from the website' : 'your image'}: ${String(mediaName(s.media)).replace(/^site: /, '')}`)
      : s.type === 'narrated' ? `AI background: ${s.image_prompt.slice(0, 70)}`
      : 'title card';
    const onScreen = [s.headline, ...(s.layout === 'steps' && s.steps.length ? s.steps : s.bullets)].filter(Boolean).join(' · ');
    const fx = [s.effects?.transition && `→ ${s.effects.transition}`, ...(s.effects?.items ?? [])].filter(Boolean).join(', ');
    return `| ${i + 1} | ${slots[i].start.toFixed(1)}s | ${cell(s.layout || s.type)} | ${cell(onScreen)} | ${cell(visual)} | ${cell(fx)} | ${cell(s.speech)} |`;
  });
  const lines = [
    `### Storyboard — ${plan.title}`,
    `~${Math.round(total)}s · ${plan.scenes.length} scenes · style **${STYLES[plan.style]?.label ?? plan.style}** (${STYLES[plan.style]?.description ?? ''}) · accent ${plan.palette.accent}`,
    `_Styles: ${STYLE_IDS.map(id => STYLES[id].label).join(', ')} — say e.g. "make it Editorial" to switch._`,
    plan.presenter ? `**Presenter:** ${plan.presenter.description} (${plan.presenter.gender ?? 'female'} voice)` : '**Presenter:** none (voiceover only)',
    ...(plan.removedClaims?.length ? [`⚠ Removed claims not found in the brief or website: ${plan.removedClaims.map(c => `"${c}"`).join(', ')} — tell me if any of them are real and I'll put them back.`] : []),
    `**Music:** ${plan.music.prompt}`,
    ...(plan.scenes.some(s => s.effects) ? [`**Effects** (picked from the HyperFrames catalogue${plan.effects?.overlay ? `; whole video: ${plan.effects.overlay}` : ''}) — say e.g. "use a light leak into scene 4" to change them.`] : []),
    '',
    '| # | At | Layout | On screen | Visual | Effects | Voiceover |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ];
  return lines.join('\n');
}

/**
 * Handle one chat turn for the explainer session in `convId`.
 * @param {object} turn  { convId, message, images: [{name,dataUrl}], opts (validated, first turn only) }
 * @param {object} ui    { say(markdown), progress(msg), saveVideo(file, title) → url, studioLink?(projectId) → url,
 *                         legacyProject?() → old one-shot project dir name for this conversation, or null }
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
    let dir = projectDir(id);
    let state = load(dir);
    // A stub left by a command mistaken for a brief (before this guard existed).
    if (state?.stage === 'questions' && isCommand(state.brief)) { rmSync(join(dir, 'state.json')); state = null; }
    if (!state && ui.legacyProject) {
      state = adoptLegacyProject(convId, ui.legacyProject());
      if (state) dir = projectDir(id);
    }
    const llm = explainerLLM();
    const progress = (m) => ui.progress(m);

    // ── New session: research + questions ───────────────────────────
    if (!state && isCommand(message)) {
      ui.say('There\'s no video in this conversation yet. Describe the video you want — the product, audience, key points, and any links — and attach a logo or screenshots if you have them.');
      return;
    }
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

    // ── Fresh Studio link on request (links expire after 10 min) ─────
    if (OPEN_STUDIO.test(message)) {
      if (state.stage !== 'done') {
        ui.say('Studio opens on the finished video. Approve the storyboard first — once it has rendered, say **open studio** to edit it.');
      } else {
        ui.say(studioLine(id, ui).trim() || 'Studio is not available on this server.');
      }
      return;
    }

    // ── Studio "Copy prompt" pasted here: Alice edits the file directly ──
    if (parseStudioPrompt(message)) {
      if (state.stage !== 'done') {
        ui.say('Direct edits work on the finished video. Approve the storyboard first; once it has rendered you can paste prompts from Studio here.');
        return;
      }
      const { assets } = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
      const slots = layoutTimeline(state.plan.scenes, assets);
      const target = parseStudioPrompt(message);
      const instruction = studioInstruction(message);
      // "Zoom in / highlight X, then Y" on a screenshot or footage scene: the vision-guided camera does it.
      if (target.scene != null && assets[target.scene]?.mediaFile && FOCUS_REQUEST.test(instruction)) {
        progress(`Finding what to highlight in scene ${target.scene + 1}…`);
        const fx = await withLLM(() => applyFocusEdit(dir, state.plan, target.scene, instruction, { llm, check: checkProject }), { onProgress: progress });
        if (fx.ok) {
          progress(`Zooming to ${fx.found.map(t => `"${t}"`).join(' → ')} — rendering…`);
          const file = await renderProject(dir, join(dir, 'out.mp4'));
          state.composedAt = compositionMtime(dir);
          save(dir, state);
          const url = await ui.saveVideo(file, state.plan.title);
          const missed = fx.targets.filter(t => !fx.found.includes(t));
          ui.say(`Done — scene ${target.scene + 1} now zooms to ${fx.found.map(t => `**${t}**`).join(', then ')}, each highlighted as the narration reaches it, then pulls back out.${missed.length ? ` I couldn't find ${missed.map(t => `"${t}"`).join(', ')} on that screen.` : ''}\n\n[Download video](${url})\n\n<video controls width="640" src="${url}"></video>`);
          return;
        }
        progress(`⚠ ${fx.message} — trying a direct edit instead…`);
      }
      progress(`Editing ${target.file}${target.retargeted ? ` (scene ${target.scene + 1})` : ''}…`);
      const res = await withLLM(() => applyDirectEdit(dir, state.plan, slots, message, { llm }), { onProgress: progress });
      if (!res.ok) {
        ui.say(`I couldn't make that edit cleanly — the result kept failing checks, so I left **${res.file}** unchanged:\n\n${res.problems.slice(0, 4).map(p => `- ${p}`).join('\n')}\n\nTry rewording the request, or make this one by hand in Studio.`);
        return;
      }
      progress('Edit passed checks — rendering…');
      const file = await renderProject(dir, join(dir, 'out.mp4'));
      state.handEdited = true;
      state.composedAt = compositionMtime(dir);
      save(dir, state);
      const url = await ui.saveVideo(file, state.plan.title);
      ui.say(`Done — edited **${res.file}**${res.attempts > 1 ? ' (second attempt)' : ''}. If Studio is open it has already reloaded the change.\n\n[Download video](${url})\n\n<video controls width="640" src="${url}"></video>`);
      return;
    }

    // ── Render the project exactly as edited in Studio ──────────────
    if (state.stage === 'done' && RENDER_EDITS.test(message)) {
      progress('Rendering your Studio edits…');
      const file = await renderProject(dir, join(dir, 'out.mp4'));
      state.composedAt = compositionMtime(dir);
      state.handEdited = true;
      save(dir, state);
      const url = await ui.saveVideo(file, state.plan.title);
      ui.say(`**${state.plan.title}** — rendered with your Studio edits.\n\n[Download video](${url})\n\n<video controls width="640" src="${url}"></video>${studioLine(id, ui)}`);
      return;
    }
    if (state.stage === 'done' && hasStudioEdits(dir, state) && !OVERRIDE_EDITS.test(message)) {
      ui.say('You\'ve edited this video in Studio. Revising the storyboard would rebuild the composition and **replace those edits**.\n\nReply **render my edits** to render what you have in Studio, or repeat your request with the word **anyway** to revise the storyboard (and lose the Studio edits).');
      return;
    }

    // ── Answers → first storyboard ──────────────────────────────────
    if (state.stage === 'questions') {
      state.answers = message && !SKIP_QUESTIONS.test(message) ? message : 'No answers — use your suggested defaults.';
      progress('Writing the storyboard…');
      state.plan = await withLLM(() => planExplainer(llm, planCtx()), { onProgress: progress });
      progress('Reviewing the HyperFrames catalogue for effects…');
      state.plan = await withLLM(() => reviewEffects(llm, state.plan, { creative: !!state.opts.creative }), { onProgress: progress });
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
        state.composedAt = compositionMtime(dir);
        save(dir, state);
        const url = await ui.saveVideo(out.file, state.plan.title);
        const warn = out.warnings.length ? `\n\n_Notes: ${out.warnings.join('; ')}_` : '';
        ui.say(`\n**${state.plan.title}** is ready.${warn}\n\n[Download video](${url})\n\n<video controls width="640" src="${url}"></video>${studioLine(id, ui)}\n\nWant changes? Tell me what to adjust and I'll update the storyboard — unchanged scenes are reused.`);
      } catch (err) {
        state.stage = 'storyboard';
        save(dir, state);
        throw err;
      }
      return;
    }

    state.handEdited = false; // a revision rebuilds the composition from the plan
    progress('Revising the storyboard…');
    const previous = currentEffects(state.plan);
    const focusByMedia = new Map(state.plan.scenes.filter(s => s.media && s.focus?.length).map(s => [s.media, s.focus]));
    state.plan = await withLLM(() => revisePlan(llm, state.plan, message, planCtx()), { onProgress: progress });
    // Keep "zoom to X, then Y" targets on scenes that still show the same media.
    for (const s of state.plan.scenes) if (s.media && focusByMedia.has(s.media)) s.focus = focusByMedia.get(s.media);
    // Re-review effects: keeps earlier picks unless the feedback (e.g. "use a light leak into scene 4") changes them.
    state.plan = await withLLM(() => reviewEffects(llm, state.plan, { creative: !!state.opts.creative, feedback: message, previous }), { onProgress: progress });
    return await showStoryboard(dir, state, ui, progress);
  } finally {
    locks.delete(id);
  }
}

function studioLine(projectId, ui) {
  if (!ui.studioLink) return '';
  try {
    return `\n\n✏️ [Open in HyperFrames Studio](${ui.studioLink(projectId)}) — fine-tune text, timing and animation on the timeline (link valid 10 minutes), then reply **render my edits**.`;
  } catch { return ''; }
}

async function showStoryboard(dir, state, ui, progress) {
  const anim = await makeAnimatic(dir, state.plan, state.ctx, { voice: state.opts.voice, portraitFile: state.portraitFile }, progress);
  state.stage = 'storyboard';
  save(dir, state);
  const url = await ui.saveVideo(anim.file, `Storyboard: ${state.plan.title}`);
  ui.say(`${storyboardMarkdown(state.plan, anim.slots, state.ctx)}\n\n**Animatic** (draft: real voiceover and layouts${state.plan.presenter && !state.portraitFile ? '; presenter shown as a placeholder' : ''}; AI backgrounds not generated yet):\n\n<video controls width="640" src="${url}"></video>\n\nReply **approve** to render the full video, or tell me what to change.`);
}
