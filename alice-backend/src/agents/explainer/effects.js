/**
 * Native versions of HyperFrames catalogue effects (see catalog.js NATIVE),
 * so a reviewed effect still happens in template scenes and between scenes.
 *
 *   transitions  crossfade, wipe, push, zoom, slideup, flash (style presets)
 *                + whip, iris, leak — chosen per scene by the effects review
 *   text         word-rise, blur-in, shimmer, marker — applied to a template
 *                scene's headline after it's built (applySceneFx)
 *   callout      spotlight | circle | outline — screenshot targets (showcase.js)
 *   cta          cta-lockup — words land, the button pulses a ring
 *   logo         logo-sting — the logo slams in and flashes
 *   overlay      vignette | grain — whole-video layers (timeline.js)
 */

import { NATIVE } from './catalog.js';

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Turn reviewed catalogue names into native ids per role, plus the names
 * that only a Qwen-written scene can use (adapt).
 * @param {{transition?: string, items?: string[]}} sceneFx
 */
export function resolveFx(sceneFx = {}) {
  const fx = { adapt: [] };
  const names = [sceneFx.transition, ...(sceneFx.items ?? [])].filter(Boolean);
  for (const name of names) {
    const n = NATIVE[name];
    if (n) { if (!fx[n.role]) fx[n.role] = n.id; } else fx.adapt.push(name);
  }
  return fx;
}

/** Transition tweens for entering scene i (#bgw-i over #bgw-prev). */
export function transitionTweens(type, { i, prev, t, D, W, H }) {
  const out = [];
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
    case 'whip': // whip-pan-cut: both layers race sideways under motion blur
      out.push(`tl.fromTo("#bgw-${prev}", { x: 0, filter: "blur(0px)" }, { x: ${r2(-W * 0.55)}, filter: "blur(28px)", duration: ${r2(D * 0.6)}, ease: "power3.in" }, ${t});`,
        `tl.fromTo("#bgw-${i}", { x: ${r2(W * 0.55)}, filter: "blur(28px)", opacity: 0 }, { x: 0, filter: "blur(0px)", opacity: 1, duration: ${r2(D * 0.75)}, ease: "power3.out" }, ${r2(t + D * 0.25)});`);
      break;
    case 'iris': // iris-reveal: a circle opens from the centre
      out.push(`tl.fromTo("#bgw-${i}", { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)", duration: ${D}, ease: "power3.inOut" }, ${t});`);
      break;
    case 'leak': // light-leak: a warm burn washes across while the scenes cross
      out.push(`tl.fromTo("#leak-${i}", { opacity: 0, x: ${r2(-W * 0.25)} }, { opacity: 0.95, x: 0, duration: ${r2(D * 0.5)}, ease: "power2.in" }, ${r2(t - D * 0.2)});`,
        `tl.to("#leak-${i}", { opacity: 0, x: ${r2(W * 0.2)}, duration: ${r2(D * 0.8)}, ease: "power2.out" }, ${r2(t + D * 0.3)});`,
        `tl.fromTo("#bgw-${i}", { opacity: 0 }, { opacity: 1, duration: ${D}, ease: "power1.inOut" }, ${t});`);
      break;
    default: // crossfade
      out.push(`tl.fromTo("#bgw-${i}", { opacity: 0 }, { opacity: 1, duration: ${D}, ease: "power1.inOut" }, ${t});`);
  }
  return out;
}

/** Extra root elements a transition needs (flash / leak overlays). */
export function transitionLayer(type, i, start, dur) {
  if (type === 'flash') return `<div id="flash-${i}" class="clip flash" data-start="${r2(Math.max(0, start - dur * 0.3))}" data-duration="${r2(dur * 1.3)}" data-track-index="4"></div>`;
  if (type === 'leak') return `<div id="leak-${i}" class="clip leak" data-start="${r2(Math.max(0, start - dur * 0.3))}" data-duration="${r2(dur * 1.5)}" data-track-index="4"></div>`;
  return '';
}

export const TRANSITION_CSS = `
  .flash { position: absolute; inset: 0; background: #ffffff; opacity: 0; }
  .leak { position: absolute; inset: -10%; opacity: 0; mix-blend-mode: screen;
    background: radial-gradient(ellipse 60% 50% at 30% 40%, rgba(255,170,90,0.95), transparent 70%), radial-gradient(ellipse 45% 60% at 70% 60%, rgba(255,90,60,0.8), transparent 70%), radial-gradient(ellipse 30% 30% at 50% 20%, rgba(255,240,200,0.9), transparent 70%); }`;

/** Whole-video overlay layer + css. */
export function overlayLayer(kind, total) {
  if (kind === 'vignette') {
    return { html: `<div id="ov-vignette" class="clip" data-start="0" data-duration="${total}" data-track-index="9"></div>`,
      css: `  #ov-vignette { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 75% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.42) 100%); }`, tweens: [] };
  }
  if (kind === 'grain') {
    const noise = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>";
    return { html: `<div id="ov-grain" class="clip" data-start="0" data-duration="${total}" data-track-index="9"></div>`,
      css: `  #ov-grain { position: absolute; inset: 0; pointer-events: none; opacity: 0.09; mix-blend-mode: overlay; background-image: url("${noise}"); }`,
      // Stepped background shifts read as live grain; seek-safe (one tween, stepped ease).
      tweens: [`tl.fromTo("#ov-grain", { backgroundPosition: "0px 0px" }, { backgroundPosition: "${Math.round(total * 24 * 37)}px ${Math.round(total * 24 * 53)}px", duration: ${total}, ease: "steps(${Math.max(1, Math.round(total * 24))})" }, 0);`] };
  }
  return { html: '', css: '', tweens: [] };
}

// ── template scene post-processing ─────────────────────────────────────

/** Wrap every word of headline html in spans (accent spans keep their class). */
export function wordSpans(inner, cls) {
  let accent = false;
  return inner.replace(/(<span class="accent">)|(<\/span>)|([^<\s]+)|(\s+)/g, (m, open, close, word, space) => {
    if (open) { accent = true; return ''; }
    if (close) { accent = false; return ''; }
    if (space) return space;
    return `<span class="${cls}${accent ? ' accent' : ''}">${word}</span>`;
  });
}

// Headline element: <h1 id="X-h"> in most layouts, <div id="X-q"> (already
// split into word spans) in "statement", <div id="X-h"> in "stat".
const headRe = (hid) => new RegExp(`(<(?:h1|div) id="${hid}">)([\\s\\S]*?)(</(?:h1|div)>)`);
const headTweenRe = (hid) => new RegExp(`^ *tl\\.fromTo\\("#${hid}",.*?, ([\\d.]+)\\);$`, 'm');
const ACCENT_SPAN = /(<span[^>]*\bclass="[^"]*\baccent\b[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/;

/**
 * Apply native text / cta / logo effects to a template scene's html.
 * Returns html unchanged for anything it can't find.
 */
export function applySceneFx(html, id, layout, fx = {}, st) {
  let out = html;
  const accent = st?.palette?.accent ?? '#ffffff';
  const addCss = (css) => { out = out.replace('</style>', `${css}\n</style>`); };
  const hid = out.includes(`id="${id}-q"`) ? `${id}-q` : `${id}-h`;
  const preSplit = hid.endsWith('-q'); // statement: words are already spans with their own entrances
  const at = Number(headTweenRe(hid).exec(out)?.[1] ?? 0.3);
  const text = layout === 'cta' && fx.cta === 'cta-lockup' ? 'word-land' : fx.text;
  if (!headRe(hid).test(out)) return out;

  if ((text === 'word-rise' || text === 'word-land') && !preSplit) {
    out = out.replace(headRe(hid), (m, a, inner, b) => `${a}${wordSpans(inner, `${id}-w`)}${b}`);
    addCss(`  .${id}-w { display: inline-block; }`);
    const tween = text === 'word-land'
      ? `  tl.fromTo("#${hid} .${id}-w", { y: 70, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.8)", stagger: 0.09 }, ${r2(at)});`
      : `  tl.fromTo("#${hid} .${id}-w", { y: 40, opacity: 0, filter: "blur(8px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.55, ease: "power3.out", stagger: 0.08 }, ${r2(at)});`;
    out = out.replace(headTweenRe(hid), tween);
  } else if (text === 'blur-in' && !preSplit) {
    out = out.replace(headTweenRe(hid), `  tl.fromTo("#${hid}", { opacity: 0, filter: "blur(22px)", scale: 1.05 }, { opacity: 1, filter: "blur(0px)", scale: 1, duration: 1.0, ease: "power2.out" }, ${r2(at)});`);
  } else if (text === 'shimmer') {
    out = out.replace(headRe(hid), (m, a, inner, b) => `${a}${inner}<span id="${id}-shine"></span>${b}`);
    addCss(`  #${hid} { position: relative; }
  #${id}-shine { position: absolute; top: -10%; bottom: -10%; left: 0; width: 28%; pointer-events: none; mix-blend-mode: overlay; background: linear-gradient(100deg, transparent, rgba(255,255,255,0.85), transparent); opacity: 0; }`);
    const t0 = r2(at + (preSplit ? 1.2 : 0.7));
    out = out.replace('window.__timelines', `tl.fromTo("#${id}-shine", { xPercent: -110, opacity: 1 }, { xPercent: 400, opacity: 1, duration: 1.1, ease: "power2.inOut" }, ${t0});\n  tl.to("#${id}-shine", { opacity: 0, duration: 0.1 }, ${r2(t0 + 1.1)});\n  window.__timelines`);
  } else if (text === 'marker') {
    // Hand-drawn underline under the first highlighted word (or the whole headline).
    const svg = `<svg id="${id}-mkr" viewBox="0 0 400 24" preserveAspectRatio="none"><path d="M4 15 C 70 6, 150 21, 230 12 S 350 7, 396 13" pathLength="1" stroke="${accent}" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;
    out = out.replace(headRe(hid), (m, a, inner, b) => {
      if (ACCENT_SPAN.test(inner)) return `${a}${inner.replace(ACCENT_SPAN, (mm, o, w, c) => `${o.replace('class="', `class="${id}-mkw `)}${w}${svg}${c}`)}${b}`;
      return `${a}<span class="${id}-mkw">${inner}${svg}</span>${b}`;
    });
    addCss(`  .${id}-mkw { position: relative; display: inline-block; }
  #${id}-mkr { position: absolute; left: -2%; width: 104%; bottom: -0.32em; height: 0.36em; overflow: visible; }`);
    out = out.replace('window.__timelines', `tl.fromTo("#${id}-mkr path", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.7, ease: "power2.inOut" }, ${r2(at + (preSplit ? 1.0 : 0.6))});\n  window.__timelines`);
  }

  if (layout === 'cta' && fx.cta === 'cta-lockup') {
    // Replace the idle button bob with one confident pop + an expanding ring.
    out = out.replace(/^ *tl\.fromTo\("#[\w-]+-btn", \{ scale: 1 \}, \{ scale: 1\.05,.*$/m,
      `  tl.fromTo("#${id}-btn", { boxShadow: "0 0 0 0px ${accent}aa" }, { boxShadow: "0 0 0 46px ${accent}00", duration: 0.9, ease: "power2.out" }, 1.3);`);
  }
  if (fx.logo === 'logo-sting') {
    out = out.replace(new RegExp(`^ *tl\\.fromTo\\("#${id}-logo".*$`, 'm'),
      `  tl.fromTo("#${id}-logo", { scale: 1.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.42, ease: "back.out(2.4)" }, 0.05);\n  tl.fromTo("#${id}-logo", { filter: "brightness(2.4)" }, { filter: "brightness(1)", duration: 0.4, ease: "power2.out" }, 0.45);`);
  }
  return out;
}

/** SVG callout around a screenshot target (showcase.js). */
export function calloutShape(kind, id, n, box, scale, accent) {
  const pad = 14 / scale, sw = r2(5 / scale);
  const x = r2(box.x - pad), y = r2(box.y - pad), w = r2(box.w + 2 * pad), h = r2(box.h + 2 * pad);
  const path = kind === 'circle'
    // a slightly wobbly ellipse that overshoots its start, like a pen stroke
    ? `M ${r2(w * 0.08)} ${r2(h * 0.3)} C ${r2(w * 0.2)} ${r2(-h * 0.05)}, ${r2(w * 0.85)} ${r2(-h * 0.08)}, ${r2(w * 0.97)} ${r2(h * 0.42)} C ${r2(w * 1.05)} ${r2(h * 0.95)}, ${r2(w * 0.2)} ${r2(h * 1.08)}, ${r2(w * 0.03)} ${r2(h * 0.62)} C ${r2(-w * 0.02)} ${r2(h * 0.42)}, ${r2(w * 0.1)} ${r2(h * 0.18)}, ${r2(w * 0.28)} ${r2(h * 0.08)}`
    : `M 10 0 H ${r2(w - 10)} Q ${w} 0 ${w} 10 V ${r2(h - 10)} Q ${w} ${h} ${r2(w - 10)} ${h} H 10 Q 0 ${h} 0 ${r2(h - 10)} V 10 Q 0 0 10 0 Z`;
  return `<svg id="${id}-co${n}" class="${id}-co" style="left:${x}px; top:${y}px; width:${w}px; height:${h}px;" viewBox="0 0 ${w} ${h}"><path d="${path}" pathLength="1" stroke="${accent}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;
}
