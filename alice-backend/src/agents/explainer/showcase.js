/**
 * The "showcase" layout: real product media in a browser-style window,
 * headline + bullets beside it — made to look like someone using the product.
 *
 *   - Screenshot with zoom targets (focus.js): a cursor glides to each
 *     bullet's region as the narrator reaches it, clicks (ripple), the rest
 *     of the screen dims around it (spotlight) and the camera follows.
 *   - Tall screenshot (a captured full web page): the window scrolls like a
 *     browser, stopping at the targets; with no targets it scrolls through.
 *   - Site demo-video clip (capture.js): the real footage plays in the window
 *     from the clip's start and runs on into the following footage for as
 *     long as the scene lasts (a walkthrough continues naturally); the last
 *     frame holds only if the video itself ends first.
 *   - Plain screenshot: slow push-in.
 *
 * Everything lives on one "stage" inside the window's viewport; the camera
 * transforms the stage (origin 0 0), so the cursor/spotlight stay glued to
 * the screenshot. The cursor, ripple and spotlight border are counter-scaled
 * so they stay a constant size on screen.
 */

import { revealTimes, shell, esc, escRaw, r2 } from './layouts.js';
import { entrance, headCss, bulletCss, marker } from './styles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Camera keyframes: one per bullet with a zoom target.
 * W×H = the media drawn at window width; Hv = the visible viewport height
 * (< H for tall pages, which then scroll).
 */
export function cameraKeys({ focus, size, times, width: W, viewportH, duration }) {
  if (!focus?.some(Boolean) || !size?.width || !size?.height) return [];
  const H = W * size.height / size.width;
  const Hv = viewportH ?? H;
  const tall = H > Hv + 1;
  const keys = focus.map((f, i) => (f ? { f, at: Math.max(0.4, times[i] - 0.25), i } : null)).filter(Boolean);
  return keys.map((k, n) => {
    const { f } = k;
    const S = clamp(0.8 * Math.min(1 / f.w, Hv / (f.h * H)), tall ? 1 : 1.25, 2.4);
    const cx = (f.x + f.w / 2) * W, cy = (f.y + f.h / 2) * H;
    const tx = clamp(W / 2 - cx * S, W * (1 - S), 0);
    const ty = clamp(Hv / 2 - cy * S, Hv - H * S, 0);
    const next = keys[n + 1]?.at ?? duration;
    return { ...k, S, tx, ty, cx, cy, box: { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H }, dur: clamp(next - k.at - 0.1, 0.4, 0.9), next };
  });
}

/** Camera tweens for the stage (exported for tests). '' when there are no targets. */
export function focusTweens(sel, opts) {
  const keys = cameraKeys(opts);
  if (!keys.length) return '';
  const out = [`  tl.fromTo("${sel}", { x: 0, y: 0, scale: 1 }, { x: 0, y: 0, scale: 1, duration: 0.01 }, 0);`];
  for (const k of keys) out.push(`  tl.to("${sel}", { x: ${r2(k.tx)}, y: ${r2(k.ty)}, scale: ${r2(k.S)}, duration: ${r2(k.dur)}, ease: "power2.inOut" }, ${r2(k.at)});`);
  const back = Math.max(keys.at(-1).at + 1.6, opts.duration - 1.3);
  if (back + 0.8 <= opts.duration - 0.1) out.push(`  tl.to("${sel}", { x: 0, y: 0, scale: 1, duration: 0.8, ease: "power2.inOut" }, ${r2(back)});`);
  return out.join('\n');
}

const CURSOR_SVG = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.6 20.3 L11.7 13.6 L18 13.4 Z" fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/** Cursor, click ripples and spotlight boxes for the camera keys. */
function interaction(id, keys, { W, Hv, duration, accent }) {
  if (!keys.length) return { css: '', html: '', js: '' };
  const css = `
  #${id}-cursor { position: absolute; left: 0; top: 0; width: 34px; height: 34px; transform-origin: 0 0; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.45)); z-index: 5; }
  .${id}-spot { position: absolute; border-radius: 10px; box-shadow: 0 0 0 4000px rgba(8,10,16,0.38); opacity: 0; z-index: 3; }
  .${id}-ring { position: absolute; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; border: 4px solid ${accent}; opacity: 0; z-index: 4; }`;
  const html = [
    ...keys.map((k, n) => `<div id="${id}-spot${n}" class="${id}-spot" style="left:${r2(k.box.x - 6)}px; top:${r2(k.box.y - 6)}px; width:${r2(k.box.w + 12)}px; height:${r2(k.box.h + 12)}px; border:${r2(3 / k.S)}px solid ${accent};"></div>`),
    ...keys.map((k, n) => `<div id="${id}-ring${n}" class="${id}-ring" style="left:${r2(k.cx)}px; top:${r2(k.cy)}px;"></div>`),
    `<div id="${id}-cursor">${CURSOR_SVG}</div>`,
  ].join('\n');
  // Cursor enters from the lower right of the first view, then visits each target.
  const js = [`  tl.fromTo("#${id}-cursor", { x: ${r2(W * 0.82)}, y: ${r2(Hv * 0.86)}, scale: 1, opacity: 0 }, { x: ${r2(W * 0.7)}, y: ${r2(Hv * 0.7)}, scale: 1, opacity: 1, duration: 0.5, ease: "power1.out" }, 0.5);`];
  keys.forEach((k, n) => {
    const inv = r2(1 / k.S);
    const click = r2(k.at + Math.max(0.45, k.dur * 0.85));
    js.push(`  tl.to("#${id}-cursor", { x: ${r2(k.cx - 4 * inv)}, y: ${r2(k.cy - 2 * inv)}, scale: ${inv}, duration: ${r2(Math.max(0.4, k.dur * 0.85))}, ease: "power2.inOut" }, ${r2(k.at)});`);
    js.push(`  tl.to("#${id}-cursor", { scale: ${r2(inv * 0.82)}, duration: 0.09, ease: "power1.in" }, ${click});`);
    js.push(`  tl.to("#${id}-cursor", { scale: ${inv}, duration: 0.14, ease: "power1.out" }, ${r2(click + 0.09)});`);
    // immediateRender: false — otherwise gsap paints each ring's "from" state at t=0.
    js.push(`  tl.fromTo("#${id}-ring${n}", { scale: ${r2(0.3 * inv)}, opacity: 0.9 }, { scale: ${r2(1.6 * inv)}, opacity: 0, duration: 0.55, ease: "power2.out", immediateRender: false }, ${click});`);
    // Each spotlight fades before the next target's (they'd stack otherwise); the last one stays until the pull-back.
    const last = n === keys.length - 1;
    const off = r2(last ? Math.min(Math.max(k.at + 1.6, duration - 1.3), duration - 0.3) : Math.max(click + 0.35, k.next - 0.1));
    js.push(`  tl.fromTo("#${id}-spot${n}", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.out", immediateRender: false }, ${r2(click + 0.05)});`);
    js.push(`  tl.to("#${id}-spot${n}", { opacity: 0, duration: 0.2, ease: "power1.in" }, ${off});`);
  });
  const end = Math.max(keys.at(-1).at + 1.6, duration - 1.3);
  if (end + 0.8 <= duration - 0.1) js.push(`  tl.to("#${id}-cursor", { x: ${r2(W * 0.72)}, y: ${r2(Hv * 0.74)}, scale: 1, duration: 0.8, ease: "power2.inOut" }, ${r2(end)});`);
  return { css, html, js: js.join('\n') };
}

export function showcase(id, s, ctx) {
  const st = ctx.style;
  const times = revealTimes(s.bullets, ctx.words, { firstAt: 1.1, gap: st.motion.stagger, latest: ctx.duration - 0.8 });
  const shotW = Math.round(ctx.canvas.width * 0.6);
  const mk = marker(st, id, 0.3);
  const light = st.mode === 'light';
  const video = ctx.mediaVideo;
  const size = ctx.mediaSize;
  const H = size?.width ? shotW * size.height / size.width : null;
  // A captured full web page is far taller than the window: show a 16:10 viewport and scroll.
  const Hv = H && H > shotW * 0.75 ? Math.round(shotW * 0.625) : H;
  const keys = video ? [] : cameraKeys({ focus: ctx.mediaFocus, size, times, width: shotW, viewportH: Hv, duration: ctx.duration });
  const act = interaction(id, keys, { W: shotW, Hv: Hv ?? shotW * 0.5625, duration: ctx.duration, accent: st.palette.accent });

  let camera;
  if (keys.length) camera = focusTweens(`#${id}-stage`, { focus: ctx.mediaFocus, size, times, width: shotW, viewportH: Hv, duration: ctx.duration });
  else if (Hv && H > Hv + 1) camera = `  tl.fromTo("#${id}-stage", { y: 0 }, { y: ${r2(Hv - H)}, duration: ${r2(Math.max(1, ctx.duration - 1.4))}, ease: "power1.inOut" }, 0.8);`;
  else camera = `  tl.fromTo("#${id}-stage", { scale: 1.0 }, { scale: ${video ? 1.08 : 1.06}, duration: ${r2(Math.max(1, ctx.duration - 0.2))}, ease: "none" }, 0.2);`;

  // Footage available to this scene (up to the next clip another scene uses);
  // stretch it a little (>= 0.55x) rather than freeze, then hold the last frame.
  const playable = video ? Math.max(0.5, (video.limit ?? video.total ?? video.end) - video.start) : 0;
  const rate = video ? clamp(playable / ctx.duration, 0.55, 1) : 1;
  const media = video
    ? `<img id="${id}-poster" src="${escRaw(video.endFrame ?? video.poster)}" alt="" />
  <video id="${id}-vid" src="${escRaw(ctx.mediaFile)}" muted playsinline data-has-audio="false" data-volume="0" data-start="0" data-media-start="${r2(video.start)}" data-duration="${r2(Math.min(ctx.duration, playable / rate))}"${rate < 1 ? ` data-playback-rate="${r2(rate)}"` : ''} data-track-index="0"></video>`
    : `<img id="${id}-img" src="${escRaw(ctx.mediaFile ?? '')}" alt="" />`;

  const css = `
  #${id}-txt { position: absolute; left: 0; top: 0; bottom: 0; width: ${ctx.canvas.width - shotW - 60}px; display: flex; flex-direction: column; justify-content: center; }
  ${mk.css}
  #${id}-h { margin: 0; ${headCss(st, 64)} }
  #${id}-list { margin-top: 36px; display: flex; flex-direction: column; gap: 18px; }
  .${id}-item { display: flex; align-items: center; font-size: 36px; font-weight: 500; }
  ${bulletCss(st, `${id}-dot`, 16)}
  #${id}-shot { position: absolute; right: 0; top: 0; bottom: 0; width: ${shotW}px; display: flex; align-items: center; }
  #${id}-win { position: relative; width: ${shotW}px; border-radius: ${Math.min(18, st.card.radius || 0)}px; overflow: hidden;
    background: ${light ? '#ffffff' : '#1b1f27'}; box-shadow: ${st.panel.shadow}; border: ${light ? '1px solid rgba(0,0,0,0.15)' : '2px solid rgba(255,255,255,0.12)'}; }
  #${id}-chrome { height: 38px; display: flex; align-items: center; gap: 10px; padding-left: 18px; background: ${light ? '#ebe6dc' : '#2a2f3a'}; }
  .${id}-dotc { width: 13px; height: 13px; border-radius: 50%; }
  #${id}-viewport { position: relative; overflow: hidden;${Hv ? ` height: ${Math.round(Hv)}px;` : ''} }
  #${id}-stage { position: relative; width: ${shotW}px; transform-origin: 0 0; }
  #${id}-stage img, #${id}-stage video { display: block; width: 100%; height: auto; }
  #${id}-vid { position: absolute; left: 0; top: 0; }${act.css}`;
  const body = `<div id="${id}-txt">${mk.html}<h1 id="${id}-h">${esc(s.headline)}</h1>
  <div id="${id}-list">${s.bullets.map((b, i) => `<div id="${id}-b${i}" class="${id}-item"><span class="${id}-dot"></span>${esc(b)}</div>`).join('')}</div></div>
  <div id="${id}-shot"><div id="${id}-win"><div id="${id}-chrome"><span class="${id}-dotc" style="background:#ff5f57"></span><span class="${id}-dotc" style="background:#febc2e"></span><span class="${id}-dotc" style="background:#28c840"></span></div>
  <div id="${id}-viewport" data-layout-allow-overflow><div id="${id}-stage">
  ${media}
  ${act.html}
  </div></div></div></div>`;
  const script = `  tl.fromTo("#${id}-win", { y: 60, opacity: 0, rotationY: -8, transformPerspective: 1600 }, { y: 0, opacity: 1, rotationY: 0, duration: 0.9, ease: "${st.motion.ease}" }, 0.1);
${camera}
${act.js}
${mk.tween}
${entrance(st, `#${id}-h`, 0.45, { distance: 30 })}
${s.bullets.map((_, i) => entrance(st, `#${id}-b${i}`, times[i], { distance: 24, dur: st.motion.dur * 0.75 })).join('\n')}`;
  return shell(id, ctx.canvas, css, body, script, st);
}
