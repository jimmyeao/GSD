/**
 * Layout library for explainer scene graphics.
 *
 * The planner (LLM) picks a layout per scene and supplies its content; these
 * builders own the design and motion. Every builder returns a HyperFrames
 * sub-composition file (transparent overlay) sized to the scene's canvas —
 * the safe area it's mounted at (timeline.js SAFE_AREAS) — so the same
 * layout adapts to a full-width narrated scene or the narrow column beside
 * a presenter.
 *
 * Reveal timing: items appear near the spoken word they relate to when word
 * timings are available (revealTimes), else on a steady stagger.
 */

export const LAYOUTS = ['bullets', 'stat', 'steps', 'compare', 'statement', 'showcase', 'title', 'cta'];

const escRaw = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Escape text and render the planner's *highlight* markup as accent spans
// (any stray unmatched asterisk is dropped rather than shown).
const esc = (s) => escRaw(s).replace(/\*([^*]+)\*/g, '<span class="accent">$1</span>').replace(/\*/g, '');
const r2 = (n) => Math.round(n * 100) / 100;
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

function shell(compId, canvas, css, body, script, { palette, font }) {
  return `<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body><template>
<style>
  #root { position: absolute; inset: 0; font-family: "${font}", sans-serif; color: ${palette.text}; }
  .accent { color: ${palette.accent}; }
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
  const narrow = ctx.canvas.width < 1000;
  const times = revealTimes(s.bullets, ctx.words, { latest: ctx.duration - 0.8 });
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  #${id}-bar { width: 120px; height: 10px; border-radius: 5px; background: ${ctx.palette.accent}; margin-bottom: 36px; }
  #${id}-h { margin: 0; font-size: ${narrow ? 66 : 84}px; font-weight: 800; line-height: 1.06; max-width: ${ctx.canvas.width}px; }
  #${id}-list { margin-top: 44px; display: flex; flex-direction: column; gap: 22px; }
  .${id}-item { display: flex; align-items: center; font-size: ${narrow ? 38 : 46}px; font-weight: 500; }
  .${id}-dot { width: 18px; height: 18px; border-radius: 50%; background: ${ctx.palette.accent}; margin-right: 22px; flex: none; }`;
  const body = `<div id="${id}-box"><div id="${id}-bar"></div><h1 id="${id}-h">${esc(s.headline)}</h1>
  <div id="${id}-list">${s.bullets.map((b, i) => `<div id="${id}-b${i}" class="${id}-item"><span class="${id}-dot"></span>${esc(b)}</div>`).join('')}</div></div>`;
  const script = `  tl.fromTo("#${id}-bar", { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, 0.1);
  tl.fromTo("#${id}-h", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, 0.2);
${s.bullets.map((_, i) => `  tl.fromTo("#${id}-b${i}", { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: "power2.out" }, ${times[i]});`).join('\n')}`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function stat(id, s, ctx) {
  const st = s.stat ?? {};
  const from = Number.isFinite(st.from) ? st.from : 0;
  const to = Number.isFinite(st.to) ? st.to : 100;
  const decimals = [from, to].some(n => !Number.isInteger(n)) ? 1 : 0;
  const fmt = (n) => `${esc(st.prefix ?? '')}${n.toFixed(decimals)}${esc(st.suffix ?? '')}`;
  const narrow = ctx.canvas.width < 1000;
  const countFor = Math.min(2.2, Math.max(1, ctx.duration - 2));
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: ${narrow ? 'flex-start' : 'center'}; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-h { margin: 0 0 18px; font-size: ${narrow ? 44 : 56}px; font-weight: 600; opacity: 0.9; }
  #${id}-n { font-size: ${narrow ? 170 : 240}px; font-weight: 800; line-height: 1; color: ${ctx.palette.accent}; font-variant-numeric: tabular-nums; }
  #${id}-l { margin-top: 24px; font-size: ${narrow ? 40 : 52}px; font-weight: 500; max-width: ${ctx.canvas.width}px; }`;
  const body = `<div id="${id}-box"><div id="${id}-h">${esc(s.headline)}</div><div id="${id}-n">${fmt(from)}</div><div id="${id}-l">${esc(st.label ?? '')}</div></div>`;
  const script = `  const num = document.getElementById("${id}-n");
  const counter = { v: ${from} };
  tl.fromTo("#${id}-h", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.15);
  tl.fromTo("#${id}-n", { scale: 0.85, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "back.out(1.6)" }, 0.35);
  tl.fromTo(counter, { v: ${from} }, { v: ${to}, duration: ${r2(countFor)}, ease: "power2.out",
    onUpdate: () => { num.textContent = ${JSON.stringify(st.prefix ?? '')} + counter.v.toFixed(${decimals}) + ${JSON.stringify(st.suffix ?? '')}; } }, 0.6);
  tl.fromTo("#${id}-l", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power2.out" }, ${r2(Math.min(0.6 + countFor, ctx.duration - 0.8))});`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function steps(id, s, ctx) {
  const items = (s.steps?.length ? s.steps : s.bullets).slice(0, 4);
  const narrow = ctx.canvas.width < 1000;
  const times = revealTimes(items, ctx.words, { firstAt: 0.8, gap: 0.6, latest: ctx.duration - 0.8 });
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  #${id}-h { margin: 0 0 48px; font-size: ${narrow ? 60 : 76}px; font-weight: 800; }
  #${id}-row { display: flex; flex-direction: ${narrow ? 'column' : 'row'}; gap: ${narrow ? 22 : 32}px; }
  .${id}-card { flex: 1; background: rgba(255,255,255,0.07); border: 2px solid rgba(255,255,255,0.12); border-radius: 24px; padding: ${narrow ? '22px 28px' : '36px 32px'}; display: flex; ${narrow ? 'align-items: center; gap: 24px;' : 'flex-direction: column; gap: 20px;'} }
  .${id}-num { width: 64px; height: 64px; border-radius: 50%; background: ${ctx.palette.accent}; color: ${ctx.palette.bg}; font-size: 34px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; }
  .${id}-t { font-size: ${narrow ? 34 : 40}px; font-weight: 600; line-height: 1.2; }`;
  const body = `<div id="${id}-box"><h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-row">
  ${items.map((t, i) => `<div id="${id}-c${i}" class="${id}-card"><div class="${id}-num">${i + 1}</div><div class="${id}-t">${esc(t)}</div></div>`).join('\n  ')}</div></div>`;
  const script = `  tl.fromTo("#${id}-h", { y: 36, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.15);
${items.map((_, i) => `  tl.fromTo("#${id}-c${i}", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, ${times[i]});`).join('\n')}`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function compare(id, s, ctx) {
  const c = s.compare ?? {};
  const left = (c.left ?? []).slice(0, 3);
  const right = (c.right ?? []).slice(0, 3);
  const narrow = ctx.canvas.width < 1000;
  const mid = Math.min(ctx.duration * 0.45, ctx.duration - 1.6);
  const col = (side, title, items, accent) => `<div id="${id}-${side}" class="${id}-col${accent ? ` ${id}-hot` : ''}"><div class="${id}-ct">${esc(title)}</div>${items.map((t, i) => `<div id="${id}-${side}${i}" class="${id}-ci">${esc(t)}</div>`).join('')}</div>`;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; }
  #${id}-h { margin: 0 0 40px; font-size: ${narrow ? 56 : 72}px; font-weight: 800; }
  #${id}-row { display: flex; flex-direction: ${narrow ? 'column' : 'row'}; gap: 32px; }
  .${id}-col { flex: 1; border-radius: 24px; padding: ${narrow ? '22px 28px' : '34px 36px'}; background: rgba(255,255,255,0.06); border: 2px solid rgba(255,255,255,0.1); opacity: 0.75; }
  .${id}-hot { background: ${ctx.palette.accent}22; border-color: ${ctx.palette.accent}; opacity: 1; }
  .${id}-ct { font-size: ${narrow ? 36 : 44}px; font-weight: 800; margin-bottom: 18px; }
  .${id}-hot .${id}-ct { color: ${ctx.palette.accent}; }
  .${id}-ci { font-size: ${narrow ? 30 : 38}px; font-weight: 500; margin-top: 12px; }`;
  const body = `<div id="${id}-box"><h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-row">
  ${col('l', c.left_title || 'Before', left, false)}
  ${col('r', c.right_title || 'After', right, true)}</div></div>`;
  const script = `  tl.fromTo("#${id}-h", { y: 36, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.15);
  tl.fromTo("#${id}-l", { x: -40, opacity: 0 }, { x: 0, opacity: 0.75, duration: 0.6, ease: "power3.out" }, 0.6);
  tl.fromTo("#${id}-r", { x: 40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, ${r2(Math.max(1.2, mid))});
  tl.fromTo("#${id}-r", { scale: 1 }, { scale: 1.03, duration: 0.4, ease: "power2.out", yoyo: true, repeat: 1 }, ${r2(Math.max(1.9, mid + 0.7))});`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function statement(id, s, ctx) {
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
  #${id}-q { font-size: ${narrow ? 72 : 104}px; font-weight: 800; line-height: 1.12; max-width: ${Math.round(ctx.canvas.width * 0.92)}px; }
  .${id}-w { display: inline-block; margin-right: 0.24em; }`;
  const body = `<div id="${id}-box"><div id="${id}-q">${spans.map((x, i) => `<span id="${id}-w${i}" class="${id}-w${x.hot ? ' accent' : ''}">${esc(x.w)}</span>`).join('')}</div></div>`;
  const step = Math.min(0.12, Math.max(0.05, (ctx.duration - 1.5) / Math.max(1, spans.length)));
  const script = spans.map((_, i) => `  tl.fromTo("#${id}-w${i}", { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" }, ${r2(0.2 + i * step)});`).join('\n');
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function showcase(id, s, ctx) {
  // Real product screenshot in a browser-style frame, text beside it.
  const times = revealTimes(s.bullets, ctx.words, { firstAt: 1.1, gap: 0.7, latest: ctx.duration - 0.8 });
  const shotW = Math.round(ctx.canvas.width * 0.6);
  const css = `
  #${id}-txt { position: absolute; left: 0; top: 0; bottom: 0; width: ${ctx.canvas.width - shotW - 60}px; display: flex; flex-direction: column; justify-content: center; }
  #${id}-bar { width: 110px; height: 10px; border-radius: 5px; background: ${ctx.palette.accent}; margin-bottom: 32px; }
  #${id}-h { margin: 0; font-size: 64px; font-weight: 800; line-height: 1.08; }
  #${id}-list { margin-top: 36px; display: flex; flex-direction: column; gap: 18px; }
  .${id}-item { display: flex; align-items: center; font-size: 36px; font-weight: 500; }
  .${id}-dot { width: 16px; height: 16px; border-radius: 50%; background: ${ctx.palette.accent}; margin-right: 18px; flex: none; }
  #${id}-win { position: absolute; right: 0; top: 50%; margin-top: -${Math.round(shotW * 0.33)}px; width: ${shotW}px; border-radius: 18px; overflow: hidden;
    background: #1b1f27; box-shadow: 0 40px 90px rgba(0,0,0,0.6); border: 2px solid rgba(255,255,255,0.12); }
  #${id}-chrome { height: 38px; display: flex; align-items: center; gap: 10px; padding-left: 18px; background: #2a2f3a; }
  .${id}-dotc { width: 13px; height: 13px; border-radius: 50%; }
  #${id}-viewport { position: relative; overflow: hidden; }
  #${id}-img { display: block; width: 100%; height: auto; transform-origin: 50% 40%; }`;
  const body = `<div id="${id}-txt"><div id="${id}-bar"></div><h1 id="${id}-h">${esc(s.headline)}</h1>
  <div id="${id}-list">${s.bullets.map((b, i) => `<div id="${id}-b${i}" class="${id}-item"><span class="${id}-dot"></span>${esc(b)}</div>`).join('')}</div></div>
  <div id="${id}-win"><div id="${id}-chrome"><span class="${id}-dotc" style="background:#ff5f57"></span><span class="${id}-dotc" style="background:#febc2e"></span><span class="${id}-dotc" style="background:#28c840"></span></div>
  <div id="${id}-viewport"><img id="${id}-img" src="${escRaw(ctx.mediaFile ?? '')}" alt="" /></div></div>`;
  const script = `  tl.fromTo("#${id}-win", { y: 60, opacity: 0, rotationY: -8, transformPerspective: 1600 }, { y: 0, opacity: 1, rotationY: 0, duration: 0.9, ease: "power3.out" }, 0.1);
  tl.fromTo("#${id}-img", { scale: 1.0 }, { scale: 1.06, duration: ${r2(Math.max(1, ctx.duration - 0.2))}, ease: "none" }, 0.2);
  tl.fromTo("#${id}-bar", { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, 0.3);
  tl.fromTo("#${id}-h", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.45);
${s.bullets.map((_, i) => `  tl.fromTo("#${id}-b${i}", { x: -24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: "power2.out" }, ${times[i]});`).join('\n')}`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

const logoHtml = (id, ctx, narrow) => (ctx.logoFile ? `<img id="${id}-logo" src="${escRaw(ctx.logoFile)}" alt="" style="max-height: ${narrow ? 90 : 130}px; max-width: ${narrow ? 360 : 520}px; margin-bottom: 36px; object-fit: contain;" />` : '');
const logoTween = (id, ctx) => (ctx.logoFile ? `  tl.fromTo("#${id}-logo", { y: 20, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 0.7, ease: "power3.out" }, 0.05);` : '');

function title(id, s, ctx) {
  const sub = s.bullets[0] ?? '';
  const narrow = ctx.canvas.width < 1000;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: ${narrow ? 'flex-start' : 'center'}; justify-content: center; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-bar { width: 140px; height: 10px; border-radius: 5px; background: ${ctx.palette.accent}; margin-bottom: 40px; }
  #${id}-h { margin: 0; font-size: ${narrow ? 68 : 118}px; font-weight: 800; line-height: 1.04; max-width: ${ctx.canvas.width - (narrow ? 0 : 80)}px; }
  #${id}-s { margin-top: 34px; font-size: ${narrow ? 36 : 48}px; font-weight: 500; opacity: 0.85; }`;
  const body = `<div id="${id}-box">${ctx.logoFile ? logoHtml(id, ctx, narrow) : `<div id="${id}-bar"></div>`}<h1 id="${id}-h">${esc(s.headline)}</h1>${sub ? `<div id="${id}-s">${esc(sub)}</div>` : ''}</div>`;
  const script = `${ctx.logoFile ? logoTween(id, ctx) : `  tl.fromTo("#${id}-bar", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out" }, 0.1);`}
  tl.fromTo("#${id}-h", { y: 50, opacity: 0, scale: 0.96 }, { y: 0, opacity: 1, scale: 1, duration: 0.8, ease: "power3.out" }, 0.25);
${sub ? `  tl.fromTo("#${id}-s", { y: 24, opacity: 0 }, { y: 0, opacity: 0.85, duration: 0.6, ease: "power2.out" }, 0.8);` : ''}`;
  return shell(id, ctx.canvas, css, body, script, ctx);
}

function cta(id, s, ctx) {
  const button = s.bullets[0] || 'Get started';
  const narrow = ctx.canvas.width < 1000;
  const css = `
  #${id}-box { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: ${narrow ? 'flex-start' : 'center'}; justify-content: center; text-align: ${narrow ? 'left' : 'center'}; }
  #${id}-h { margin: 0; font-size: ${narrow ? 64 : 104}px; font-weight: 800; line-height: 1.05; max-width: ${ctx.canvas.width - (narrow ? 0 : 80)}px; }
  #${id}-btn { margin-top: ${narrow ? 40 : 56}px; padding: ${narrow ? '20px 44px' : '26px 64px'}; border-radius: 999px; background: ${ctx.palette.accent}; color: ${ctx.palette.bg}; font-size: ${narrow ? 36 : 46}px; font-weight: 800; transform-origin: ${narrow ? 'left center' : 'center'}; }
  #${id}-sub { margin-top: ${narrow ? 22 : 30}px; font-size: ${narrow ? 30 : 38}px; opacity: 0.8; }`;
  const body = `<div id="${id}-box">${logoHtml(id, ctx, narrow)}<h1 id="${id}-h">${esc(s.headline)}</h1><div id="${id}-btn">${esc(button)}</div>${s.bullets[1] ? `<div id="${id}-sub">${esc(s.bullets[1])}</div>` : ''}</div>`;
  const script = `${logoTween(id, ctx)}
  tl.fromTo("#${id}-h", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, 0.2);
  tl.fromTo("#${id}-btn", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "back.out(1.8)" }, 0.8);
  tl.fromTo("#${id}-btn", { scale: 1 }, { scale: 1.05, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: 3 }, 1.6);
${s.bullets[1] ? `  tl.fromTo("#${id}-sub", { opacity: 0 }, { opacity: 0.8, duration: 0.6 }, 1.2);` : ''}`;
  return shell(id, ctx.canvas, css, body, script, ctx);
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
 * @param {{palette, font, duration, canvas:{width,height}, words?, mediaFile?, logoFile?}} ctx
 */
export function buildLayoutHtml(compId, scene, ctx) {
  let layout = LAYOUTS.includes(scene.layout) && layoutFits(scene.layout, scene) ? scene.layout : defaultLayout(scene);
  if (layout === 'showcase' && !ctx.mediaFile) layout = 'bullets';
  if (scene.media && ctx.mediaFile && layout !== 'showcase' && scene.type === 'narrated') layout = 'showcase';
  return BUILDERS[layout](compId, scene, { ...ctx, words: ctx.words ?? [] });
}
