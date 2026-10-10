/**
 * Deterministic HyperFrames composition builder for the explainer pipeline.
 *
 * Owns everything a local LLM tends to get wrong: absolute timing, media
 * placement, audio mixing, captions, and the root timeline. The LLM only
 * contributes per-scene *graphics* sub-compositions (compositions/scene-N.html,
 * transparent overlays) — and fallbackSceneHtml() below stands in for any
 * scene whose LLM version fails lint.
 *
 * Layout (1920x1080):
 *   track 0  per-scene background (image w/ Ken Burns, or palette gradient)
 *   track 1  presenter video panel (presenter scenes)
 *   track 2  scene graphics sub-composition (LLM or fallback)
 *   track 3  captions
 *   track 5+ audio: voiceover, sfx, music
 */

import { buildLayoutHtml } from './layouts.js';
import { resolveStyle } from './styles.js';

export const W = 1920;
export const H = 1080;
const VOICE_LEAD = 0.3;     // voiceover starts this far into its scene
const TAIL = 0.6;           // breathing room after the last word
const CAPTION_MAX_WORDS = 5;
const CAPTION_GAP = 0.35;

// Presenter panel: the ID-LoRA clip (1280x704) scaled into the right side,
// leaving the left ~45% for headline/bullets.
export const PRESENTER_BOX = { right: 80, top: 230, width: 1040, height: 572 };
// Safe text regions handed to the scene writer, by scene type.
// Each scene's graphics sub-composition is MOUNTED at exactly this box (its
// canvas is the safe area), so LLM output physically can't cover the
// presenter panel or the caption band — no instruction-following needed.
export const SAFE_AREAS = {
  presenter: { x: 100, y: 180, width: 660, height: 640 }, // ends 40px before PRESENTER_BOX (x 800)
  narrated: { x: 120, y: 120, width: 1680, height: 760 },
  title: { x: 160, y: 160, width: 1600, height: 720 },
  outro: { x: 160, y: 160, width: 1600, height: 720 },
};
// Bottom band reserved for captions — scene graphics must stay above it.
export const CAPTION_BAND = { bottom: 60, height: 120 };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Scene length from its real assets.
 * @param {object} scene  plan scene
 * @param {{voiceDur?: number, clipDur?: number}} a
 */
export function sceneDuration(scene, a = {}) {
  if (scene.type === 'presenter' && a.clipDur) return r2(a.clipDur);
  if (a.voiceDur) return r2(VOICE_LEAD + a.voiceDur + TAIL);
  return scene.type === 'outro' ? 4 : 3.5;
}

/** Assign absolute start/duration to each scene. */
export function layoutTimeline(scenes, assets) {
  let t = 0;
  return scenes.map((scene, i) => {
    const duration = sceneDuration(scene, assets[i]);
    const slot = { index: i, start: r2(t), duration };
    t += duration;
    return slot;
  });
}

/**
 * Caption words = the SCRIPT's words (exact spelling of names), timed by
 * whisper. ASR misspells brand names ("TheiaCast" → "TheaCast",
 * "ThayerCast"), so its text is only used to align: LCS over normalized
 * tokens maps script words to recognised words; unmatched script words are
 * interpolated between matched neighbours. With no transcript, words are
 * spread evenly over `duration` (used by the draft animatic).
 */
export function alignScriptWords(script, asrWords = [], duration = 0) {
  const tokens = String(script ?? '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!asrWords.length) {
    const step = (duration || tokens.length * 0.4) / tokens.length;
    return tokens.map((text, i) => ({ text, start: r2(i * step), end: r2((i + 1) * step - 0.02) }));
  }
  const a = tokens.map(norm), b = asrWords.map(w => norm(w.text));
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const match = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] && a[i] === b[j]) { match[i++] = j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const first = asrWords[0].start, last = asrWords.at(-1).end;
  const out = tokens.map((text, i) => (match[i] >= 0 ? { text, start: asrWords[match[i]].start, end: asrWords[match[i]].end } : { text, start: null, end: null }));
  for (let i = 0; i < n; i++) {
    if (out[i].start !== null) continue;
    let k = i; while (k < n && out[k].start === null) k++;
    const from = i > 0 ? out[i - 1].end : first;
    const to = k < n ? out[k].start : last;
    const step = Math.max(0.05, (to - from) / (k - i));
    for (let q = i; q < k; q++) { out[q].start = r2(from + (q - i) * step); out[q].end = r2(from + (q - i + 1) * step - 0.02); }
    i = k - 1;
  }
  return out;
}

/**
 * Group word timings into caption chunks (scene-local seconds in, absolute out).
 * Breaks on CAPTION_MAX_WORDS, a pause > CAPTION_GAP, or sentence end.
 */
export function captionChunks(words, offset, sceneEnd) {
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length && (cur.length >= CAPTION_MAX_WORDS || w.start - cur.at(-1).end > CAPTION_GAP)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  return chunks.map((c, i) => {
    const start = r2(offset + c[0].start);
    const next = chunks[i + 1] ? offset + chunks[i + 1][0].start : Math.min(offset + c.at(-1).end + 0.4, sceneEnd);
    return { text: c.map(w => w.text).join(' '), start, duration: r2(Math.max(0.3, next - start)) };
  });
}

/**
 * Graphics layer for a scene from the layout library (layouts.js) — the
 * default renderer, and the fallback for any LLM-written scene that fails
 * checks. Same file contract as LLM output: <template>, root id = compId,
 * one paused timeline at window.__timelines[compId].
 */
export function fallbackSceneHtml(compId, scene, { style, palette, font, duration, words, mediaFile, mediaSize, mediaFocus, mediaVideo, logoFile }) {
  const canvas = SAFE_AREAS[scene.type] ?? SAFE_AREAS.narrated;
  return buildLayoutHtml(compId, scene, { style, palette, font, duration, words, canvas, mediaFile, mediaSize, mediaFocus, mediaVideo, logoFile });
}

// ── Style backgrounds ──────────────────────────────────────────────────
// Everything inside #bgw-<i> (a NON-timed wrapper inside the timed .bg clip)
// so transitions can transform/clip it freely. Animated decoration gets ids
// (bgx-<i>-<k>) and main-timeline tweens at the scene's global time.

function decorHtml(i, scene, st) {
  const a = st.palette.accent, bg = st.palette.bg, bg2 = st.palette.bg2;
  const side = i % 2 === 0 ? 'right' : 'left';
  // Presenter scenes keep the big block behind the panel (right), off the text column.
  const blockSide = scene.type === 'presenter' ? 'right' : side;
  switch (st.background) {
    case 'paper':
      return `<div class="fill" style="background: radial-gradient(ellipse at ${side === 'right' ? '85% 10%' : '15% 10%'}, #ffffff99 0%, transparent 55%), linear-gradient(180deg, ${bg} 0%, ${bg2} 100%);"></div>
<div id="bgx-${i}-0" class="rule" style="${side}: 90px; background: ${a};"></div>`;
    case 'blocks':
      return `<div class="fill" style="background: ${bg};"></div>
<div id="bgx-${i}-0" class="block" style="${blockSide}: -520px; top: ${i % 3 === 0 ? -480 : 560}px; background: ${a};"></div>
<div id="bgx-${i}-1" class="block2" style="${blockSide === 'right' ? 'left' : 'right'}: -330px; bottom: -360px; background: ${bg2}; border: 6px solid ${a}55;"></div>`;
    case 'grid':
      return `<div class="fill" style="background: radial-gradient(circle at 70% 30%, ${a}22 0%, transparent 50%), ${bg};"></div>
<div id="bgx-${i}-0" class="gridlines" style="background-image: linear-gradient(${a}1f 1px, transparent 1px), linear-gradient(90deg, ${a}1f 1px, transparent 1px);"></div>`;
    case 'aurora':
      return `<div class="fill" style="background: ${bg};"></div>
<div id="bgx-${i}-0" class="blob" style="${side}: -120px; top: -160px; background: ${a}55;"></div>
<div id="bgx-${i}-1" class="blob" style="${side === 'right' ? 'left' : 'right'}: -200px; bottom: -260px; background: ${bg2};"></div>`;
    case 'spotlight':
      return `<div class="fill" style="background: linear-gradient(160deg, ${bg2} 0%, ${bg} 70%);"></div>
<div id="bgx-${i}-0" class="spot" style="background: radial-gradient(circle, ${a}55 0%, transparent 60%);"></div>`;
    default: { // gradient
      const angle = (i * 47) % 360;
      return `<div class="fill" style="background: radial-gradient(circle at ${scene.type === 'presenter' ? '75% 50%' : '50% 40%'}, ${a}33 0%, transparent 55%), linear-gradient(${angle}deg, ${bg} 0%, ${bg2} 100%);"></div>`;
    }
  }
}

/** Ambient motion for a scene's decoration (global time). */
function decorTweens(i, slot, st) {
  const t = slot.start, d = slot.duration;
  switch (st.background) {
    case 'paper': return [`tl.fromTo("#bgx-${i}-0", { scaleY: 0, transformOrigin: "top center" }, { scaleY: 1, duration: 1.2, ease: "power2.inOut" }, ${r2(t + 0.1)});`];
    case 'blocks': return [
      `tl.fromTo("#bgx-${i}-0", { rotation: -18, xPercent: ${i % 2 === 0 ? 40 : -40} }, { rotation: -12, xPercent: 0, duration: 0.6, ease: "back.out(1.4)" }, ${r2(t)});`,
      `tl.fromTo("#bgx-${i}-1", { rotation: 20, scale: 0.6 }, { rotation: 14, scale: 1, duration: 0.7, ease: "back.out(1.6)" }, ${r2(t + 0.1)});`];
    case 'grid': return [`tl.fromTo("#bgx-${i}-0", { backgroundPosition: "0px 0px" }, { backgroundPosition: "0px 120px", duration: ${d}, ease: "none" }, ${t});`];
    case 'aurora': return [
      `tl.fromTo("#bgx-${i}-0", { x: 0, y: 0 }, { x: ${i % 2 ? 80 : -80}, y: 60, duration: ${d}, ease: "sine.inOut" }, ${t});`,
      `tl.fromTo("#bgx-${i}-1", { x: 0, y: 0 }, { x: ${i % 2 ? -60 : 60}, y: -40, duration: ${d}, ease: "sine.inOut" }, ${t});`];
    case 'spotlight': return [`tl.fromTo("#bgx-${i}-0", { x: ${i % 2 ? 900 : -300}, y: -100 }, { x: ${i % 2 ? -300 : 900}, y: 200, duration: ${d}, ease: "sine.inOut" }, ${t});`];
    default: return [];
  }
}

function backgroundHtml(i, scene, slot, a, st, clipDuration) {
  const base = `id="bg-${i}" class="clip bg" data-start="${slot.start}" data-duration="${clipDuration}" data-track-index="0"`;
  const inner = scene.type === 'narrated' && a.imageFile
    ? `<div id="kb-${i}" class="kb"><img id="img-${i}" src="${esc(a.imageFile)}" alt="" /></div><div class="shade"></div>`
    : decorHtml(i, scene, st);
  return `<div ${base}><div id="bgw-${i}" class="bgw">${inner}</div></div>`;
}

/**
 * Scene-to-scene transition tweens (entering scene i at slot.start).
 * The previous scene's background/graphics stay on screen for `dur` (their
 * clips are extended), so the new scene can be revealed over them.
 */
function transitionTweens(i, slot, st, scene) {
  if (i === 0) return [];
  const t = r2(slot.start), { type, dur } = st.transition;
  const D = r2(dur), prev = i - 1;
  const out = [`tl.to("#g-${prev}", { opacity: 0, duration: ${r2(D * 0.6)}, ease: "power1.in" }, ${t});`];
  const gfxIn = `tl.fromTo("#g-${i}", { opacity: 0 }, { opacity: 1, duration: ${D}, ease: "power1.out" }, ${t});`;
  const presIn = scene.type === 'presenter' ? `tl.fromTo("#presenter-${i}", { opacity: 0 }, { opacity: 1, duration: ${D}, ease: "power1.out" }, ${t});` : '';
  switch (type) {
    case 'wipe':
      out.push(`tl.fromTo("#bgw-${i}", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${D}, ease: "power2.inOut" }, ${t});`);
      break;
    case 'push':
      out.push(`tl.fromTo("#bgw-${i}", { x: ${W} }, { x: 0, duration: ${D}, ease: "power3.inOut" }, ${t});`,
        `tl.fromTo("#bgw-${prev}", { x: 0 }, { x: ${-W}, duration: ${D}, ease: "power3.inOut" }, ${t});`);
      break;
    case 'zoom':
      out.push(`tl.fromTo("#bgw-${i}", { scale: 1.35, opacity: 0 }, { scale: 1, opacity: 1, duration: ${D}, ease: "expo.out" }, ${t});`,
        `tl.fromTo("#bgw-${prev}", { scale: 1 }, { scale: 0.85, duration: ${D}, ease: "power2.in" }, ${t});`);
      break;
    case 'slideup':
      out.push(`tl.fromTo("#bgw-${i}", { y: ${H} }, { y: 0, duration: ${D}, ease: "power3.out" }, ${t});`);
      break;
    case 'flash':
      out.push(`tl.fromTo("#flash-${i}", { opacity: 0 }, { opacity: 1, duration: ${r2(D * 0.3)}, ease: "power2.in" }, ${r2(t - D * 0.3)});`,
        `tl.to("#flash-${i}", { opacity: 0, duration: ${r2(D * 0.7)}, ease: "power2.out" }, ${t});`);
      break;
    default: // crossfade
      out.push(`tl.fromTo("#bgw-${i}", { opacity: 0 }, { opacity: 1, duration: ${D}, ease: "power1.inOut" }, ${t});`);
  }
  out.push(gfxIn);
  if (presIn) out.push(presIn);
  return out;
}

function panelBorder(st) {
  switch (st.panel.border) {
    case 'accent': return `3px solid ${st.palette.accent}55`;
    case 'hairline': return '1px solid rgba(0,0,0,0.2)';
    case 'thick': return '6px solid #000000';
    case 'glow': return `2px solid ${st.palette.accent}`;
    default: return 'none';
  }
}

/**
 * Build the root index.html.
 * @param {object} plan     normalized plan (plan.style picks the preset)
 * @param {object[]} assets per scene: { voiceFile, voiceDur, clipFile, clipDur, imageFile, sfxFile, words }
 * @param {{musicFile?: string, portraitFile?: string}} global
 *   portraitFile is only used by the draft animatic's presenter placeholder.
 */
export function buildIndexHtml(plan, assets, { musicFile, portraitFile } = {}) {
  const st = resolveStyle(plan);
  const slots = layoutTimeline(plan.scenes, assets);
  const total = r2(slots.at(-1).start + slots.at(-1).duration);
  const T = st.transition.dur;
  const parts = [];
  const tweens = [];
  const captions = [];

  plan.scenes.forEach((scene, i) => {
    const slot = slots[i];
    const a = assets[i] ?? {};
    // Stay on screen through the next scene's entrance transition.
    const held = i < plan.scenes.length - 1 ? r2(slot.duration + T) : slot.duration;
    parts.push(backgroundHtml(i, scene, slot, a, st, held));
    if (scene.type === 'narrated' && a.imageFile) {
      tweens.push(`tl.fromTo("#kb-${i}", { scale: 1.0 }, { scale: 1.08, duration: ${held}, ease: "none" }, ${slot.start});`);
    } else {
      tweens.push(...decorTweens(i, { start: slot.start, duration: held }, st));
    }
    if (st.transition.type === 'flash' && i > 0) {
      parts.push(`<div id="flash-${i}" class="clip flash" data-start="${r2(Math.max(0, slot.start - T * 0.3))}" data-duration="${r2(T)}" data-track-index="4"></div>`);
    }
    if (scene.type === 'presenter' && a.clipFile) {
      parts.push(`<video id="presenter-${i}" class="clip presenter" src="${esc(a.clipFile)}" playsinline data-has-audio="true" data-volume="1" data-start="${slot.start}" data-duration="${slot.duration}" data-track-index="1"></video>`);
    } else if (scene.type === 'presenter') {
      // Draft animatic: presenter clip not generated yet.
      const inner = portraitFile
        ? `<img id="pph-img-${i}" src="${esc(portraitFile)}" alt="" />`
        : `<div class="pph-card"><div class="pph-head"></div><div class="pph-body"></div><div class="pph-label"><div class="pph-tag">PRESENTER</div><div>${esc(plan.presenter?.description ?? '').slice(0, 140)}</div></div></div>`;
      parts.push(`<div id="presenter-${i}" class="clip presenter pph" data-start="${slot.start}" data-duration="${slot.duration}" data-track-index="1">${inner}</div>`);
    }
    const area = SAFE_AREAS[scene.type] ?? SAFE_AREAS.narrated;
    parts.push(`<div id="g-${i}" class="gfx" style="left: ${area.x}px; top: ${area.y}px; width: ${area.width}px; height: ${area.height}px;" data-composition-id="scene-${i}" data-composition-src="compositions/scene-${i}.html" data-start="${slot.start}" data-duration="${held}" data-track-index="2" data-width="${area.width}" data-height="${area.height}"></div>`);
    tweens.push(...transitionTweens(i, slot, st, scene));

    const speechOffset = scene.type === 'presenter' ? slot.start : slot.start + VOICE_LEAD;
    if (a.voiceFile) {
      parts.push(`<audio id="vo-${i}" src="${esc(a.voiceFile)}" data-start="${r2(speechOffset)}" data-duration="${r2(a.voiceDur)}" data-volume="1" data-track-index="5"></audio>`);
    }
    if (a.sfxFile) {
      parts.push(`<audio id="sfx-${i}" src="${esc(a.sfxFile)}" data-start="${slot.start}" data-duration="${r2(Math.min(2, slot.duration))}" data-volume="0.5" data-track-index="6"></audio>`);
    }
    if (a.words?.length) captions.push(...captionChunks(a.words, speechOffset, slot.start + slot.duration));
  });

  captions.forEach((c, k) => {
    parts.push(`<div id="cap-${k}" class="clip caption" data-start="${c.start}" data-duration="${c.duration}" data-track-index="3"><span>${esc(c.text)}</span></div>`);
  });
  if (musicFile) {
    parts.push(`<audio id="music" src="${esc(musicFile)}" data-start="0" data-duration="${total}" data-volume="0.16" data-track-index="7"></audio>`);
  }

  const pal = st.palette, cap = st.caption;
  const shade = st.imageShade === 'light'
    ? `linear-gradient(90deg, ${pal.bg}f0 0%, ${pal.bg}b3 55%, ${pal.bg}cc 100%)`
    : 'linear-gradient(90deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.62) 100%)';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<title>${esc(plan.title)}</title>
<script src="assets/gsap.min.js"></script>
<style>
  body { margin: 0; background: ${pal.bg}; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${pal.bg}; font-family: "${st.font.body}", sans-serif; }
  .bg { position: absolute; inset: 0; overflow: hidden; }
  .bgw { position: absolute; inset: 0; overflow: hidden; }
  .fill { position: absolute; inset: 0; }
  .rule { position: absolute; top: 0; bottom: 0; width: 2px; opacity: 0.55; }
  .block { position: absolute; width: 820px; height: 820px; transform: rotate(-12deg); }
  .block2 { position: absolute; width: 520px; height: 520px; transform: rotate(14deg); }
  .gridlines { position: absolute; inset: -120px 0 0 0; background-size: 60px 60px; }
  .blob { position: absolute; width: 900px; height: 900px; border-radius: 50%; filter: blur(120px); }
  .spot { position: absolute; width: 1400px; height: 1400px; border-radius: 50%; }
  .flash { position: absolute; inset: 0; background: #ffffff; opacity: 0; }
  .kb { position: absolute; inset: 0; }
  .kb img { width: 100%; height: 100%; object-fit: cover; display: block; filter: blur(6px) saturate(0.85); transform: scale(1.04); }
  .shade { position: absolute; inset: 0; background: ${shade}; }
  .presenter { position: absolute; right: ${PRESENTER_BOX.right}px; top: ${PRESENTER_BOX.top}px; width: ${PRESENTER_BOX.width}px; height: ${PRESENTER_BOX.height}px;
    object-fit: cover; border-radius: ${st.panel.radius}px; box-shadow: ${st.panel.shadow}; border: ${panelBorder(st)}; }
  .gfx { position: absolute; overflow: hidden; }
  .pph { overflow: hidden; background: #20242e; }
  .pph img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pph-card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #9aa3b5; }
  .pph-head { width: 150px; height: 150px; border-radius: 50%; background: #3a4150; }
  .pph-body { width: 300px; height: 130px; border-radius: 150px 150px 0 0; background: #3a4150; margin-top: 14px; }
  .pph-tag { font-weight: 800; letter-spacing: 0.2em; margin-bottom: 8px; color: #c9d1e3; }
  .pph-label { margin-top: 22px; font-size: 24px; text-align: center; max-width: 820px; line-height: 1.35; letter-spacing: 0.02em; }
  .caption { position: absolute; left: 0; right: 0; bottom: ${CAPTION_BAND.bottom}px; display: flex; justify-content: center; }
  .caption span { background: ${cap.bg}; color: ${cap.color}; font-size: 44px; font-weight: ${cap.weight}; padding: 12px 28px; border-radius: ${cap.radius}px; text-transform: ${cap.transform}; border: ${cap.border}; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total}">
${parts.join('\n')}
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  ${tweens.join('\n  ')}
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
}
