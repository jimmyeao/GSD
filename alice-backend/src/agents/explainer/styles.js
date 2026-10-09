/**
 * Visual style presets for explainer videos — the main source of variety.
 *
 * Before these, every video used one look (dark gradient, Inter, the same
 * rise-and-fade motion, hard cuts), so only colours changed. A preset now
 * sets everything around the content: colour mode, typography, motion
 * personality, headline marker, bullet glyph, card treatment, background
 * treatment, photo shading, caption look, presenter panel and the scene
 * transition. The planner picks one per video (plan.style); the brand
 * accent from the plan is kept, and swapped for the preset's own accent if
 * it would be unreadable on the preset's background.
 *
 * Fonts are limited to ones HyperFrames resolves without an @font-face
 * (see planner ALLOWED_FONTS).
 */

export const STYLES = {
  midnight: {
    label: 'Midnight', mode: 'dark',
    description: 'calm, premium, corporate — dark navy gradient, clean sans, smooth rises and crossfades',
    colors: { bg: '#0b1020', bg2: '#000000', text: '#f5f7ff', muted: 'rgba(245,247,255,0.72)' },
    accentFallback: '#4f8cff',
    font: { display: 'Inter', body: 'Inter', headWeight: 800, headCase: 'none', tracking: '-0.01em', lineHeight: 1.06, scale: 1 },
    motion: { entrance: 'rise', ease: 'power3.out', emph: 'back.out(1.6)', dur: 0.7, stagger: 0.7 },
    marker: 'bar', bullet: 'dot',
    card: { bg: 'rgba(255,255,255,0.07)', border: '2px solid rgba(255,255,255,0.12)', radius: 24, shadow: 'none' },
    background: 'gradient', imageShade: 'dark',
    caption: { bg: 'rgba(0,0,0,0.62)', color: '#ffffff', radius: 14, weight: 600, transform: 'none', border: 'none' },
    panel: { radius: 28, border: 'accent', shadow: '0 30px 80px rgba(0,0,0,0.55)' },
    transition: { type: 'crossfade', dur: 0.5 },
  },
  editorial: {
    label: 'Editorial', mode: 'light',
    description: 'magazine-like, thoughtful, premium B2B — cream paper, serif headlines, elegant mask reveals and wipes',
    colors: { bg: '#f6f1e7', bg2: '#ece4d4', text: '#1d1a16', muted: 'rgba(29,26,22,0.7)' },
    accentFallback: '#b4462b',
    font: { display: 'Playfair Display', body: 'Inter', headWeight: 700, headCase: 'none', tracking: '-0.005em', lineHeight: 1.1, scale: 1 },
    motion: { entrance: 'mask', ease: 'power2.inOut', emph: 'power3.out', dur: 0.9, stagger: 0.8 },
    marker: 'underline', bullet: 'dash',
    card: { bg: '#fffdf8', border: '1px solid rgba(29,26,22,0.18)', radius: 6, shadow: '0 12px 30px rgba(29,26,22,0.08)' },
    background: 'paper', imageShade: 'light',
    caption: { bg: 'rgba(246,241,231,0.94)', color: '#1d1a16', radius: 4, weight: 600, transform: 'none', border: '1px solid rgba(29,26,22,0.15)' },
    panel: { radius: 6, border: 'hairline', shadow: '0 20px 50px rgba(29,26,22,0.18)' },
    transition: { type: 'wipe', dur: 0.7 },
  },
  boldpop: {
    label: 'Bold Pop', mode: 'dark',
    description: 'loud, energetic product launch / consumer promo — colour blocks, heavy uppercase type, punchy pops and pushes',
    colors: { bg: '#111111', bg2: '#1c1c1c', text: '#ffffff', muted: 'rgba(255,255,255,0.8)' },
    accentFallback: '#ffd400',
    font: { display: 'Montserrat', body: 'Montserrat', headWeight: 900, headCase: 'uppercase', tracking: '-0.015em', lineHeight: 0.98, scale: 1.04 },
    motion: { entrance: 'scale', ease: 'back.out(1.7)', emph: 'back.out(2.2)', dur: 0.45, stagger: 0.5 },
    marker: 'block', bullet: 'square',
    card: { bg: '#ffffff', border: '3px solid #000000', radius: 0, shadow: '10px 10px 0 ACCENT', text: '#111111' },
    background: 'blocks', imageShade: 'dark',
    caption: { bg: 'ACCENT', color: '#111111', radius: 0, weight: 900, transform: 'uppercase', border: 'none' },
    panel: { radius: 0, border: 'thick', shadow: '18px 18px 0 ACCENT' },
    transition: { type: 'push', dur: 0.45 },
  },
  techgrid: {
    label: 'Tech Grid', mode: 'dark',
    description: 'developer tools, SaaS, data, security — near-black with a glowing grid, technical type, blur-in reveals and zoom-throughs',
    colors: { bg: '#05070d', bg2: '#0a1220', text: '#e6f1ff', muted: 'rgba(230,241,255,0.7)' },
    accentFallback: '#00e5ff',
    font: { display: 'Roboto', body: 'Roboto', headWeight: 700, headCase: 'none', tracking: '0.01em', lineHeight: 1.08, scale: 0.98 },
    motion: { entrance: 'blur', ease: 'power2.out', emph: 'expo.out', dur: 0.6, stagger: 0.55 },
    marker: 'bracket', bullet: 'chevron',
    card: { bg: 'rgba(0,229,255,0.05)', border: '1px solid ACCENT66', radius: 8, shadow: '0 0 30px ACCENT22' },
    background: 'grid', imageShade: 'dark',
    caption: { bg: 'rgba(5,7,13,0.85)', color: '#e6f1ff', radius: 6, weight: 500, transform: 'none', border: '1px solid ACCENT88' },
    panel: { radius: 8, border: 'glow', shadow: '0 0 60px ACCENT33' },
    transition: { type: 'zoom', dur: 0.6 },
  },
  warm: {
    label: 'Warm Minimal', mode: 'light',
    description: 'friendly, human, lifestyle / small business / wellbeing — warm off-white, soft rounded cards, gentle motion',
    colors: { bg: '#f4ece2', bg2: '#ecdccb', text: '#2b211b', muted: 'rgba(43,33,27,0.7)' },
    accentFallback: '#c8553d',
    font: { display: 'Outfit', body: 'Outfit', headWeight: 700, headCase: 'none', tracking: '-0.01em', lineHeight: 1.08, scale: 1 },
    motion: { entrance: 'rise', ease: 'sine.out', emph: 'back.out(1.3)', dur: 0.85, stagger: 0.8 },
    marker: 'dot', bullet: 'dot',
    card: { bg: '#fffaf4', border: 'none', radius: 32, shadow: '0 18px 40px rgba(80,50,30,0.12)' },
    background: 'aurora', imageShade: 'light',
    caption: { bg: 'rgba(43,33,27,0.82)', color: '#fffaf4', radius: 999, weight: 500, transform: 'none', border: 'none' },
    panel: { radius: 40, border: 'none', shadow: '0 24px 60px rgba(80,50,30,0.25)' },
    transition: { type: 'slideup', dur: 0.6 },
  },
  neon: {
    label: 'Neon', mode: 'dark',
    description: 'nightlife, gaming, creative, AI — deep purple with neon glow, drops with overshoot, flash cuts',
    colors: { bg: '#0b0418', bg2: '#1a0733', text: '#fbf4ff', muted: 'rgba(251,244,255,0.75)' },
    accentFallback: '#ff3df0',
    font: { display: 'Poppins', body: 'Poppins', headWeight: 800, headCase: 'none', tracking: '-0.01em', lineHeight: 1.05, scale: 1 },
    motion: { entrance: 'drop', ease: 'back.out(1.4)', emph: 'elastic.out(1, 0.6)', dur: 0.6, stagger: 0.6 },
    marker: 'glow', bullet: 'check',
    card: { bg: 'rgba(255,255,255,0.06)', border: '1px solid ACCENT88', radius: 20, shadow: '0 0 40px ACCENT33' },
    background: 'spotlight', imageShade: 'dark',
    caption: { bg: 'rgba(26,7,51,0.85)', color: '#fbf4ff', radius: 16, weight: 600, transform: 'none', border: '1px solid ACCENT' },
    panel: { radius: 24, border: 'glow', shadow: '0 0 70px ACCENT44' },
    transition: { type: 'flash', dur: 0.4 },
  },
};

export const STYLE_IDS = Object.keys(STYLES);
export const DEFAULT_STYLE = 'midnight';

// ── colour helpers ────────────────────────────────────────────────────────
function lum(hex) {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Resolve a plan's style + palette into one token set for the builders.
 * @returns {object} preset tokens + palette {bg, bg2, text, muted, accent, onAccent}
 */
export function resolveStyle(plan) {
  const id = STYLE_IDS.includes(plan.style) ? plan.style : DEFAULT_STYLE;
  const p = STYLES[id];
  const brand = /^#[0-9a-f]{6}$/i.test(plan.palette?.accent ?? '') ? plan.palette.accent : p.accentFallback;
  const accent = contrast(brand, p.colors.bg) >= 3 ? brand : p.accentFallback;
  const onAccent = contrast('#ffffff', accent) >= contrast('#111111', accent) ? '#ffffff' : '#111111';
  const sub = (v) => (typeof v === 'string' ? v.replace(/ACCENT/g, accent) : v);
  const deep = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' ? deep(v) : sub(v)]));
  return { id, ...deep(p), palette: { ...p.colors, accent, onAccent } };
}

// ── motion helpers shared by layouts and the root timeline ────────────────
const r2 = (n) => Math.round(n * 100) / 100;

/** The style's entrance as a gsap tween string, for element `sel` at time `at`. */
export function entrance(style, sel, at, { dur, distance = 40, ease } = {}) {
  const d = r2(dur ?? style.motion.dur);
  const e = ease ?? style.motion.ease;
  const T = (from, to) => `  tl.fromTo("${sel}", ${from}, { ${to}, duration: ${d}, ease: "${e}" }, ${r2(at)});`;
  switch (style.motion.entrance) {
    case 'mask': return T('{ clipPath: "inset(0% 100% 0% 0%)", opacity: 1 }', 'clipPath: "inset(0% 0% 0% 0%)", opacity: 1');
    case 'scale': return T('{ scale: 0.6, opacity: 0 }', 'scale: 1, opacity: 1');
    case 'blur': return T(`{ filter: "blur(14px)", opacity: 0, y: ${Math.round(distance / 3)} }`, 'filter: "blur(0px)", opacity: 1, y: 0');
    case 'drop': return T(`{ y: ${-distance * 1.5}, opacity: 0 }`, 'y: 0, opacity: 1');
    case 'slide': return T(`{ x: ${-distance * 1.5}, opacity: 0 }`, 'x: 0, opacity: 1');
    default: return T(`{ y: ${distance}, opacity: 0 }`, 'y: 0, opacity: 1');
  }
}

/** Headline typography CSS. */
export function headCss(style, size) {
  const f = style.font;
  return `font-family: "${f.display}", sans-serif; font-size: ${Math.round(size * f.scale)}px; font-weight: ${f.headWeight}; line-height: ${f.lineHeight}; letter-spacing: ${f.tracking}; text-transform: ${f.headCase};`;
}

/** Headline accent marker: { html, css, tween } (placed before the headline). */
export function marker(style, id, at = 0.1) {
  const a = style.palette.accent;
  switch (style.marker) {
    case 'bar': return { html: `<div id="${id}-mk"></div>`, css: `#${id}-mk { width: 120px; height: 10px; border-radius: 5px; background: ${a}; margin-bottom: 36px; }`, tween: `  tl.fromTo("#${id}-mk", { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, ${at});` };
    case 'underline': return { html: `<div id="${id}-mk"></div>`, css: `#${id}-mk { width: 64px; height: 3px; background: ${a}; margin-bottom: 30px; }`, tween: `  tl.fromTo("#${id}-mk", { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.8, ease: "power2.inOut" }, ${at});` };
    case 'block': return { html: `<div id="${id}-mk"></div>`, css: `#${id}-mk { width: 90px; height: 90px; background: ${a}; margin-bottom: 30px; }`, tween: `  tl.fromTo("#${id}-mk", { scale: 0, rotation: -45 }, { scale: 1, rotation: 0, duration: 0.45, ease: "back.out(2)" }, ${at});` };
    case 'bracket': return { html: `<div id="${id}-mk">[ ${'//'} ]</div>`, css: `#${id}-mk { font-family: "Roboto", sans-serif; font-size: 30px; letter-spacing: 0.3em; color: ${a}; margin-bottom: 26px; text-shadow: 0 0 18px ${a}; }`, tween: `  tl.fromTo("#${id}-mk", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power2.out" }, ${at});` };
    case 'dot': return { html: `<div id="${id}-mk"></div>`, css: `#${id}-mk { width: 26px; height: 26px; border-radius: 50%; background: ${a}; margin-bottom: 30px; }`, tween: `  tl.fromTo("#${id}-mk", { scale: 0 }, { scale: 1, duration: 0.6, ease: "back.out(2)" }, ${at});` };
    case 'glow': return { html: `<div id="${id}-mk"></div>`, css: `#${id}-mk { width: 160px; height: 6px; border-radius: 3px; background: ${a}; box-shadow: 0 0 24px ${a}, 0 0 48px ${a}; margin-bottom: 34px; }`, tween: `  tl.fromTo("#${id}-mk", { scaleX: 0, opacity: 0, transformOrigin: "left center" }, { scaleX: 1, opacity: 1, duration: 0.5, ease: "power3.out" }, ${at});` };
    default: return { html: '', css: '', tween: '' };
  }
}

/** Bullet glyph CSS for class `cls` (applied to an empty span). */
export function bulletCss(style, cls, size = 18) {
  const a = style.palette.accent;
  switch (style.bullet) {
    case 'square': return `.${cls} { width: ${size}px; height: ${size}px; background: ${a}; margin-right: 22px; flex: none; }`;
    case 'dash': return `.${cls} { width: ${size * 1.6}px; height: 2px; background: ${a}; margin-right: 22px; flex: none; }`;
    case 'chevron': return `.${cls} { width: ${size * 0.7}px; height: ${size * 0.7}px; border-right: 3px solid ${a}; border-top: 3px solid ${a}; transform: rotate(45deg); margin-right: 26px; flex: none; }`;
    case 'check': return `.${cls} { width: ${size * 0.55}px; height: ${size}px; border-right: 4px solid ${a}; border-bottom: 4px solid ${a}; transform: rotate(45deg) translateY(-3px); margin-right: 26px; flex: none; filter: drop-shadow(0 0 6px ${a}); }`;
    default: return `.${cls} { width: ${size}px; height: ${size}px; border-radius: 50%; background: ${a}; margin-right: 22px; flex: none; }`;
  }
}

/** Card surface CSS. */
export function cardCss(style) {
  const c = style.card;
  return `background: ${c.bg}; border: ${c.border}; border-radius: ${c.radius}px; box-shadow: ${c.shadow};${c.text ? ` color: ${c.text};` : ''}`;
}
