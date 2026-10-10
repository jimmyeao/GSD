/**
 * Layout library for explainer scene graphics.
 *
 * The planner (LLM) picks a layout per scene and supplies its content; these
 * builders own the structure, and the video's STYLE preset (styles.js) owns
 * the look: typography, entrance motion, headline marker, bullet glyph, card
 * treatment and easing. So the same "steps" scene looks completely
 * different in Editorial vs Bold Pop. Every builder returns a HyperFrames
 * sub-composition file (transparent overlay) sized to the scene's canvas —
 * the safe area it's mounted at (timeline.js SAFE_AREAS) — so the same
 * layout adapts to a full-width narrated scene or the narrow column beside
 * a presenter.
 *
 * Reveal timing: items appear near the spoken word they relate to when word
 * timings are available (revealTimes), else on the style's stagger.
 */

import { showcase } from './showcase.js';
import { resolveFx, applySceneFx } from './effects.js';
import { resolveStyle, entrance, headCss, marker, bulletCss, cardCss } from './styles.js';

export const LAYOUTS = ['bullets', 'stat', 'steps', 'compare', 'statement', 'showcase', 'title', 'cta'];

export const escRaw = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Escape text and render the planner's *highlight* markup as accent spans
// (any stray unmatched asterisk is dropped rather than shown).
export const esc = (s) => escRaw(s).replace(/\*([^*]+)\*/g, '<span class="accent">$1</span>').replace(/\*/g, '');
export const r2 = (n) => Math.round(n * 100) / 100;
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'your', 'our', 'is', 'are']);

/**
 * When should each item appear? Match the item's first meaningful word to
 * the spoken words (in order); otherwise stagger evenly after `firstAt`.
 */
export function revealTimes(items, words = [], { firstAt = 0.9, gap = 0.7, latest }) {
  let cursor = 0;
  let prev = firstAt - gap;
  return items.map((item) => {
    const keys = String(item).split(/\s+/).map(norm).filter(k => k && !STOP.has(k));
    let t = null;
    for (let i = cursor; i < words.length && keys.length; i++) {
      if (keys.includes(norm(words[i].text))) { t = Math.max(0, words[i].start - 0.15); cursor = i + 1; break; }
    }
    if (t === null || t < prev + 0.3) t = prev + gap;
    prev = Math.min(t, latest);
    return r2(prev);
  });
}

export function shell(compId, canvas, css, body, script, st) {
  const glow = st.marker === 'glow' ? ` text-shadow: 0 0 22px ${st.palette.accent}88;` : '';
  // Bold Pop sits text on accent colour blocks, where accent-coloured words
  // vanish — so its highlights are a marker band (onAccent text on accent).
  const accentCss = st.marker === 'block'
    ? `.accent { color: ${st.palette.onAccent}; background: ${st.palette.accent}; padding: 0 0.12em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }`
    : `.accent { color: ${st.palette.accent};${glow} }`;
  return `<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body><template>
<style>
  #root { position: absolute; inset: 0; font-family: "${st.font.body}", sans-serif; color: ${st.palette.text}; }
  ${accentCss}
${css}
</style>
<div id="root" data-composition-id="${compId}" data-width="${canvas.width}" data-height="${canvas.height}">
${body}
</div>
<script>
  const tl = gsap.timeline({ paused: true });
${script}
  window.__timelines["${compId}"] = tl;
</script>
</template></body></html>
`;
}

// ── Builders ────────────────────────────────────────────────────────────

function bullets(id, s, ctx) {
  const st = ctx.style;
  const narrow = ctx.canvas.width < 1000;
  const times = revealTimes(s.bullets, ctx.words, { gap: st.motion.stagger, latest: ctx.duration - 0.8 });
  const mk = marker(st, id);
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  ${mk.css}
  #${id}-h { margin: 0; ${headCss(st, narrow ? 66 : 84)} max-width: ${ctx.canvas.width}px; }
  #${id}-list { margin-top: 44px; display: flex; flex-direction: column; gap: 22px; }
  .${id}-item { display: flex; align-items: center; font-size: ${narrow ? 38 : 46}px; font-weight: 500; }
  ${bulletCss(st, `${id}-dot`)}`;
  const body = `<div id="${id}-box">${mk.html}<h1 id="${id}-h">${esc(s.headline)}</h1>
  <div id="${id}-list">${s.bullets.map((b, i) => `<div id="${id}-b${i}" class="${id}-item"><span class="${id}-dot"></span>${esc(b)}</div>`).join('')}</div></div>`;
  const script = [mk.tween, entrance(st, `#${id}-h`, 0.2), ...s.bullets.map((_, i) => entrance(st, `#${id}-b${i}`, times[i], { distance: 30, dur: st.motion.dur * 0.75 }))].join('\n');
  return shell(id, ctx.canvas, css, body, script, st);
}

function stat(id, s, ctx) {
  const st = ctx.style;
  const sv = s.stat ?? {};
  const from = Number.isFinite(sv.from) ? sv.from : 0;
  const to = Number.isFinite(sv.to) ? sv.to : 100;
  const decimals = [from, to].some(n => !Number.isInteger(n)) ? 1 : 0;
  const fmt = (n) => `${esc(sv.prefix ?? '')}${n.toFixed(decimals)}${esc(sv.suffix ?? '')}`;
  const narrow = ctx.canvas.width < 1000;
  const countFor = Math.min(2.2, Math.max(1, ctx.duration - 2));
  const glow = st.marker === 'glow' || st.id === 'techgrid' ? ` text-shadow: 0 0 40px ${st.palette.accent}99;` : '';
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: ${narrow ? 'flex-start' : 'center'}; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-h { margin: 0 0 18px; font-size: ${narrow ? 44 : 56}px; font-weight: 600; color: ${st.palette.muted}; ${st.font.headCase === 'uppercase' ? 'text-transform: uppercase; letter-spacing: 0.08em;' : ''} }
  #${id}-n { ${headCss(st, narrow ? 170 : 240)} line-height: 1; color: ${st.palette.accent}; font-variant-numeric: tabular-nums;${glow} }
  #${id}-l { margin-top: 24px; font-size: ${narrow ? 40 : 52}px; font-weight: 500; max-width: ${ctx.canvas.width}px; }`;
  const body = `<div id="${id}-box"><div id="${id}-h">${esc(s.headline)}</div><div id="${id}-n">${fmt(from)}</div><div id="${id}-l">${esc(sv.label ?? '')}</div></div>`;
  const script = `${entrance(st, `#${id}-h`, 0.15, { distance: 30 })}
  tl.fromTo("#${id}-n", { scale: 0.85, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "${st.motion.emph}" }, 0.35);
  const num = document.getElementById("${id}-n");
  const counter = { v: ${from} };
  tl.fromTo(counter, { v: ${from} }, { v: ${to}, duration: ${r2(countFor)}, ease: "power2.out",
    onUpdate: () => { num.textContent = ${JSON.stringify(sv.prefix ?? '')} + counter.v.toFixed(${decimals}) + ${JSON.stringify(sv.suffix ?? '')}; } }, 0.6);
${entrance(st, `#${id}-l`, Math.min(0.6 + countFor, ctx.duration - 0.8), { distance: 24 })}`;
  return shell(id, ctx.canvas, css, body, script, st);
}

function steps(id, s, ctx) {
  const st = ctx.style;
  const items = (s.steps?.length ? s.steps : s.bullets).slice(0, 4);
  const narrow = ctx.canvas.width < 1000;
  const times = revealTimes(items, ctx.words, { firstAt: 0.8, gap: st.motion.stagger * 0.85, latest: ctx.duration - 0.8 });
  const numRadius = st.card.radius === 0 ? '0' : '50%';
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  #${id}-h { margin: 0 0 48px; ${headCss(st, narrow ? 60 : 76)} }
  #${id}-row { display: flex; flex-direction: ${narrow ? 'column' : 'row'}; gap: ${narrow ? 22 : 32}px; }
  .${id}-card { flex: 1; ${cardCss(st)} padding: ${narrow ? '22px 28px' : '36px 32px'}; display: flex; ${narrow ? 'align-items: center; gap: 24px;' : 'flex-direction: column; gap: 20px;'} }
  .${id}-num { width: 64px; height: 64px; border-radius: ${numRadius}; background: ${st.palette.accent}; color: ${st.palette.onAccent}; font-size: 34px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; font-family: "${st.font.display}", sans-serif; }
  .${id}-t { font-size: ${narrow ? 34 : 40}px; font-weight: 600; line-height: 1.2; }`;
  const body = `<div id="${id}-box"><h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-row">
  ${items.map((t, i) => `<div id="${id}-c${i}" class="${id}-card"><div class="${id}-num">${i + 1}</div><div class="${id}-t">${esc(t)}</div></div>`).join('\n  ')}</div></div>`;
  const script = [entrance(st, `#${id}-h`, 0.15, { distance: 36 }), ...items.map((_, i) => entrance(st, `#${id}-c${i}`, times[i], { distance: 40, dur: st.motion.dur * 0.8 }))].join('\n');
  return shell(id, ctx.canvas, css, body, script, st);
}

function compare(id, s, ctx) {
  const st = ctx.style;
  const c = s.compare ?? {};
  const left = (c.left ?? []).slice(0, 3);
  const right = (c.right ?? []).slice(0, 3);
  const narrow = ctx.canvas.width < 1000;
  const mid = Math.min(ctx.duration * 0.45, ctx.duration - 1.6);
  const col = (side, title, items, hot) => `<div id="${id}-${side}" class="${id}-col${hot ? ` ${id}-hot` : ''}"><div class="${id}-ct">${esc(title)}</div>${items.map((t, i) => `<div id="${id}-${side}${i}" class="${id}-ci">${esc(t)}</div>`).join('')}</div>`;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  #${id}-h { margin: 0 0 40px; ${headCss(st, narrow ? 56 : 72)} }
  #${id}-row { display: flex; flex-direction: ${narrow ? 'column' : 'row'}; gap: 32px; }
  .${id}-col { flex: 1; ${cardCss(st)} padding: ${narrow ? '22px 28px' : '34px 36px'}; opacity: 0.8; }
  .${id}-hot { border-color: ${st.palette.accent}; outline: 3px solid ${st.palette.accent}; outline-offset: -3px; opacity: 1; }
  .${id}-ct { font-size: ${narrow ? 36 : 44}px; font-weight: 800; margin-bottom: 18px; font-family: "${st.font.display}", sans-serif; text-transform: ${st.font.headCase}; }
  .${id}-hot .${id}-ct { color: ${st.card.text ? '#111111' : st.palette.accent}; }
  .${id}-ci { font-size: ${narrow ? 30 : 38}px; font-weight: 500; margin-top: 12px; }`;
  const body = `<div id="${id}-box"><h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-row">
  ${col('l', c.left_title || 'Before', left, false)}
  ${col('r', c.right_title || 'After', right, true)}</div></div>`;
  const script = `${entrance(st, `#${id}-h`, 0.15, { distance: 36 })}
${entrance(st, `#${id}-l`, 0.6, { distance: 40 })}
${entrance(st, `#${id}-r`, Math.max(1.2, mid), { distance: 40 })}
  tl.fromTo("#${id}-r", { scale: 1 }, { scale: 1.03, duration: 0.4, ease: "power2.out", yoyo: true, repeat: 1 }, ${r2(Math.max(1.9, mid + st.motion.dur))});`;
  return shell(id, ctx.canvas, css, body, script, st);
}

function statement(id, s, ctx) {
  const st = ctx.style;
  // Highlight the words the LLM marked with *asterisks* (or the last two).
  const raw = s.headline || '';
  const marked = /\*[^*]+\*/.test(raw);
  const words = raw.replace(/\*/g, ' * ').split(/\s+/).filter(Boolean);
  let hot = false;
  const spans = [];
  words.forEach((w) => { if (w === '*') { hot = !hot; return; } spans.push({ w, hot }); });
  if (!marked) spans.slice(-2).forEach(x => { x.hot = true; });
  const narrow = ctx.canvas.width < 1000;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; align-items: center; justify-content: ${narrow ? 'flex-start' : 'center'}; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-q { ${headCss(st, narrow ? 72 : 104)} line-height: ${Math.max(1.08, st.font.lineHeight)}; max-width: ${Math.round(ctx.canvas.width * 0.92)}px; }
  .${id}-w { display: inline-block; margin-right: 0.24em; }`;
  const body = `<div id="${id}-box"><div id="${id}-q">${spans.map((x, i) => `<span id="${id}-w${i}" class="${id}-w${x.hot ? ' accent' : ''}">${esc(x.w)}</span>`).join('')}</div></div>`;
  const step = Math.min(0.12, Math.max(0.05, (ctx.duration - 1.5) / Math.max(1, spans.length)));
  const script = spans.map((_, i) => entrance(st, `#${id}-w${i}`, 0.2 + i * step, { distance: 50, dur: Math.min(0.55, st.motion.dur) })).join('\n');
  return shell(id, ctx.canvas, css, body, script, st);
}

const logoHtml = (id, ctx, narrow) => (ctx.logoFile ? `<img id="${id}-logo" src="${escRaw(ctx.logoFile)}" alt="" style="max-height: ${narrow ? 90 : 130}px; max-width: ${narrow ? 360 : 520}px; margin-bottom: 36px; object-fit: contain;" />` : '');
const logoTween = (id, ctx) => (ctx.logoFile ? `  tl.fromTo("#${id}-logo", { y: 20, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 0.7, ease: "power3.out" }, 0.05);` : '');

function title(id, s, ctx) {
  const st = ctx.style;
  const sub = s.bullets[0] ?? '';
  const narrow = ctx.canvas.width < 1000;
  const mk = marker(st, id);
  const align = narrow || st.id === 'editorial' ? 'flex-start' : 'center';
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: ${align}; justify-content: center; text-align: ${align === 'center' ? 'center' : 'left'}; }
  ${mk.css}
  #${id}-h { margin: 0; ${headCss(st, narrow ? 68 : 118)} max-width: ${ctx.canvas.width - (narrow ? 0 : 80)}px; }
  #${id}-s { margin-top: 34px; font-size: ${narrow ? 36 : 48}px; font-weight: 500; color: ${st.palette.muted}; }`;
  const body = `<div id="${id}-box">${ctx.logoFile ? logoHtml(id, ctx, narrow) : mk.html}<h1 id="${id}-h">${esc(s.headline)}</h1>${sub ? `<div id="${id}-s">${esc(sub)}</div>` : ''}</div>`;
  const script = [ctx.logoFile ? logoTween(id, ctx) : mk.tween, entrance(st, `#${id}-h`, 0.25, { distance: 50, dur: st.motion.dur * 1.15 }), sub ? entrance(st, `#${id}-s`, 0.8, { distance: 24 }) : ''].join('\n');
  return shell(id, ctx.canvas, css, body, script, st);
}

function cta(id, s, ctx) {
  const st = ctx.style;
  const button = s.bullets[0] || 'Get started';
  const narrow = ctx.canvas.width < 1000;
  const btnRadius = st.card.radius === 0 ? 0 : 999;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: ${narrow ? 'flex-start' : 'center'}; justify-content: center; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-h { margin: 0; ${headCss(st, narrow ? 64 : 104)} max-width: ${ctx.canvas.width - (narrow ? 0 : 80)}px; }
  #${id}-btn { margin-top: ${narrow ? 40 : 56}px; padding: ${narrow ? '20px 44px' : '26px 64px'}; border-radius: ${btnRadius}px; background: ${st.palette.accent}; color: ${st.palette.onAccent}; font-size: ${narrow ? 36 : 46}px; font-weight: 800; font-family: "${st.font.display}", sans-serif; text-transform: ${st.font.headCase}; transform-origin: ${narrow ? 'left center' : 'center'};${st.marker === 'glow' ? ` box-shadow: 0 0 40px ${st.palette.accent};` : ''}${st.card.radius === 0 ? ' box-shadow: 8px 8px 0 #000000;' : ''} }
  #${id}-sub { margin-top: ${narrow ? 22 : 30}px; font-size: ${narrow ? 30 : 38}px; color: ${st.palette.muted}; }`;
  const body = `<div id="${id}-box">${logoHtml(id, ctx, narrow)}<h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-btn">${esc(button)}</div>${s.bullets[1] ? `<div id="${id}-sub">${esc(s.bullets[1])}</div>` : ''}</div>`;
  const script = `${logoTween(id, ctx)}
${entrance(st, `#${id}-h`, 0.2, { distance: 40 })}
  tl.fromTo("#${id}-btn", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "${st.motion.emph}" }, 0.8);
  tl.fromTo("#${id}-btn", { scale: 1 }, { scale: 1.05, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: 3 }, 1.6);
${s.bullets[1] ? `  tl.fromTo("#${id}-sub", { opacity: 0 }, { opacity: 1, duration: 0.6 }, 1.2);` : ''}`;
  return shell(id, ctx.canvas, css, body, script, st);
}

const BUILDERS = { bullets, stat, steps, compare, statement, showcase, title, cta };

/** Default layout when the plan didn't choose (or chose an unusable one). */
export function defaultLayout(scene) {
  if (scene.type === 'title') return 'title';
  if (scene.type === 'outro') return 'cta';
  return 'bullets';
}

/** Is the scene's content sufficient for this layout? */
export function layoutFits(layout, scene) {
  switch (layout) {
    case 'stat': return Number.isFinite(scene.stat?.to);
    case 'steps': return (scene.steps?.length ?? 0) >= 2 || scene.bullets.length >= 2;
    case 'compare': return (scene.compare?.left?.length ?? 0) > 0 && (scene.compare?.right?.length ?? 0) > 0;
    case 'statement': case 'title': case 'cta': return !!scene.headline;
    case 'showcase': return !!scene.media;
    case 'bullets': return true;
    default: return false;
  }
}

/**
 * Build a scene's graphics file.
 * @param {string} compId
 * @param {object} scene  normalized plan scene (layout + content)
 * @param {{style?, palette, font, duration, canvas:{width,height}, words?, mediaFile?, mediaSize?, mediaFocus?, mediaVideo?, logoFile?}} ctx
 *   style: a resolveStyle() result; derived from palette/font when absent.
 */
export function buildLayoutHtml(compId, scene, ctx) {
  let layout = LAYOUTS.includes(scene.layout) && layoutFits(scene.layout, scene) ? scene.layout : defaultLayout(scene);
  if (layout === 'showcase' && !ctx.mediaFile) layout = 'bullets';
  if (scene.media && ctx.mediaFile && layout !== 'showcase' && scene.type === 'narrated') layout = 'showcase';
  const style = ctx.style ?? legacyStyle(ctx);
  // Effects the review picked for this scene (catalogue names → native ids).
  const fx = ctx.fx ?? resolveFx(scene.effects);
  const html = BUILDERS[layout](compId, scene, { ...ctx, style, fx, words: ctx.words ?? [] });
  return applySceneFx(html, compId, layout, fx, style);
}

/** Pre-style callers (and tests) pass palette/font only → Midnight with that palette/font. */
function legacyStyle({ palette = {}, font = 'Inter' }) {
  const st = resolveStyle({ style: 'midnight', palette });
  st.palette = { ...st.palette, ...(palette.text ? { text: palette.text } : {}), ...(palette.bg ? { bg: palette.bg } : {}) };
  st.font = { ...st.font, display: font, body: font };
  return st;
}
