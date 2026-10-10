/**
 * The HyperFrames registry catalogue (`hyperframes catalog --json`, ~390
 * blocks and components), curated into the effects menu the planner reviews
 * for every video.
 *
 * Two kinds of menu item:
 *   native   — Alice implements the effect itself (effects.js), so it works
 *              in template scenes and between scenes, every time.
 *   adapted  — only used when Qwen writes the scene: the item's real source
 *              is installed into a scratch dir and given to the scene writer
 *              as a reference to adapt (sceneWriter.js).
 * Items that make no sense for a 16:9 product explainer (vertical-only,
 * social-network overlays, maps, podcast lower thirds, brand-specific
 * demos, transition showcase reels) are left out.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { NODE22, HYPERFRAMES_CLI_ARGS, hyperframesEnv } from './hyperframesCli.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const CACHE = join(DATA_DIR, 'hyperframes-catalog.json');
const REF_DIR = join(DATA_DIR, 'hyperframes-catalog-src');
const MAX_AGE_MS = 7 * 24 * 3600_000;

/** Catalogue name → Alice's native effect id. */
export const NATIVE = {
  // transitions into a scene
  'whip-pan-cut': { role: 'transition', id: 'whip' },
  'whip-pan': { role: 'transition', id: 'whip' },
  'iris-reveal': { role: 'transition', id: 'iris' },
  'sdf-iris': { role: 'transition', id: 'iris' },
  'light-leak': { role: 'transition', id: 'leak' },
  'organic-light-leak-overlay': { role: 'transition', id: 'leak' },
  'zoom-through-transition': { role: 'transition', id: 'zoom' },
  'cinematic-zoom': { role: 'transition', id: 'zoom' },
  'flash-through-white': { role: 'transition', id: 'flash' },
  'editorial-flash-overlay': { role: 'transition', id: 'flash' },
  'directional-wipe': { role: 'transition', id: 'wipe' },
  'page-slide': { role: 'transition', id: 'push' },
  'fade-through': { role: 'transition', id: 'crossfade' },
  // headline treatments
  'per-word-rise': { role: 'text', id: 'word-rise' },
  'staggered-fade-up': { role: 'text', id: 'word-rise' },
  'blur-in': { role: 'text', id: 'blur-in' },
  'focus-blur-resolve': { role: 'text', id: 'blur-in' },
  'text-shimmer': { role: 'text', id: 'shimmer' },
  'shimmer-sweep': { role: 'text', id: 'shimmer' },
  'marker-highlight': { role: 'text', id: 'marker' },
  'hw-underline': { role: 'text', id: 'marker' },
  // screenshot callouts (need zoom targets)
  'hw-callout-circle': { role: 'callout', id: 'circle' },
  'yt-feather-highlight': { role: 'callout', id: 'spotlight' },
  'outline-draw': { role: 'callout', id: 'outline' },
  // closing / brand
  'cta-lockup': { role: 'cta', id: 'cta-lockup' },
  'cta-close': { role: 'cta', id: 'cta-lockup' },
  'logo-sting': { role: 'logo', id: 'logo-sting' },
  // whole-video overlays
  'vignette': { role: 'overlay', id: 'vignette' },
  'grain-overlay': { role: 'overlay', id: 'grain' },
};

// Non-native items Qwen can't adapt under the scene rules (no canvas/WebGL, no gsap plugins) are out too.
const EXCLUDE_TAGS = new Set(['webgl', 'webgpu', 'webgpu-shader', 'html-in-canvas', 'liquid-glass-html-in-canvas', 'three-js', 'gltf', '3d-motion', 'canvas', 'gsap-plugin', 'motionpath', 'lottie', 'particles', 'vertical', 'social', 'social-overlay', 'map', 'podcast', 'interview', 'lower-third', 'broadcast', 'news', 'tiktok', 'instagram', 'reddit', 'twitter', 'spotify', 'youtube', 'ad-template', 'creator', 'camcorder', 'music', 'beat-driven', 'experiment', 'gaming', 'emoji', 'character', 'mascot']);
const EXCLUDE_NAME = /^(transitions-|carousel-(circle|orbit|path|vision|text-circle)-[2-5]$|heygen|blue-sweater|apple-money|nyc-paris|north-korea|spain-map|us-map|world-map|vpn-|slack-|chatgpt|claude-exchange|ai-chat-reveal|message-thread|notes-reveal|notification-cascade|share-sheet)/;
const INCLUDE_TAGS = new Set(['transition', 'transition-primitive', 'typography', 'text', 'text-effect', 'text-effects', 'reveal', 'product-demo', 'mock-ui', 'ui-props', 'cursor', 'camera', 'showcase', 'data', 'data-viz', 'chart', 'cta', 'end-card', 'brand', 'logo', 'title-card', 'handwritten', 'annotation', 'callout', 'highlight', 'overlay', 'effect', 'background', 'feature-tour', 'proof', 'stats', 'device', 'compare', 'shader', 'kinetic-type', 'motion-primitive']);

function runCatalog() {
  return new Promise((resolve) => {
    execFile(NODE22, [...HYPERFRAMES_CLI_ARGS, 'catalog', '--json'], { env: hyperframesEnv(), timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      try { resolve(err ? null : JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/** The full catalogue (cached for a week; stale cache beats none). */
export async function loadCatalog({ refresh = runCatalog } = {}) {
  const fresh = existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < MAX_AGE_MS;
  if (!fresh) {
    const items = await refresh();
    if (Array.isArray(items) && items.length) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CACHE, JSON.stringify(items));
    }
  }
  try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return []; }
}

/** Curate the catalogue into menu items: { name, kind, role, title, description, tags, native? } */
export function curate(items) {
  const out = [];
  for (const x of items ?? []) {
    if (!x?.name || typeof x.name !== 'string') continue;
    const tags = (x.tags ?? []).map(String);
    const native = NATIVE[x.name];
    const portrait = x.dimensions && x.dimensions.height > x.dimensions.width;
    if (!native) {
      if (portrait || EXCLUDE_NAME.test(x.name) || tags.some(t => EXCLUDE_TAGS.has(t))) continue;
      if (!tags.some(t => INCLUDE_TAGS.has(t))) continue;
    }
    const role = native?.role ?? roleOf(tags);
    // Between-scene transitions and whole-video overlays live in the root
    // timeline Alice builds itself, so only native ones are usable there.
    if (!native && (role === 'transition' || role === 'overlay')) continue;
    out.push({
      name: x.name, kind: x.type, title: x.title ?? x.name,
      description: String(x.description ?? '').replace(/\s+/g, ' ').slice(0, 140),
      tags: tags.slice(0, 6), role, ...(native ? { native: native.id } : {}),
    });
  }
  return out;
}

function roleOf(tags) {
  const has = (...t) => t.some(x => tags.includes(x));
  if (has('transition', 'transition-primitive')) return 'transition';
  if (has('cta', 'end-card')) return 'cta';
  if (has('logo', 'brand')) return 'logo';
  if (has('data', 'data-viz', 'chart', 'stats', 'proof')) return 'data';
  if (has('cursor', 'product-demo', 'mock-ui', 'ui-props', 'device', 'feature-tour')) return 'demo';
  if (has('handwritten', 'annotation', 'callout', 'highlight')) return 'callout';
  if (has('overlay', 'background', 'effect')) return 'overlay';
  return 'text';
}

/** Compact menu text for the reviewer prompt, grouped by role. */
export function menuText(menu) {
  const roles = ['transition', 'text', 'callout', 'demo', 'data', 'cta', 'logo', 'overlay'];
  // One name per native effect (aliases like light-leak / organic-light-leak-overlay render the same).
  const seen = new Set();
  const shown = menu.filter(m => !m.native || (!seen.has(m.native) && seen.add(m.native)));
  return roles.map(role => {
    const items = shown.filter(m => m.role === role);
    if (!items.length) return '';
    return `## ${role}\n${items.map(m => `- ${m.name}${m.native ? ' [native]' : ''}: ${m.description}`).join('\n')}`;
  }).filter(Boolean).join('\n\n');
}

/**
 * Real source of one catalogue item (installed once into a scratch project —
 * never into a video project, where lint/check would treat it as a scene).
 * Returns '' if it can't be installed.
 */
export async function itemSource(name, { maxChars = 14_000 } = {}) {
  if (!/^[a-z0-9-]{2,60}$/.test(name)) return '';
  mkdirSync(REF_DIR, { recursive: true });
  if (!existsSync(join(REF_DIR, 'hyperframes.json'))) writeFileSync(join(REF_DIR, 'hyperframes.json'), JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } }));
  const find = () => [join(REF_DIR, 'compositions', `${name}.html`), join(REF_DIR, 'compositions', 'components', `${name}.html`)].find(existsSync);
  if (!find()) {
    await new Promise((resolve) => execFile(NODE22, [...HYPERFRAMES_CLI_ARGS, 'add', name, '--dir', REF_DIR, '--no-clipboard'], { env: hyperframesEnv(), timeout: 90_000 }, () => resolve()));
  }
  const file = find();
  if (!file) return '';
  // Drop CDN script/font tags — scenes must stay offline; the motion is what's being borrowed.
  const src = readFileSync(file, 'utf8').replace(/<script[^>]+src=["']https?:[^>]*><\/script>/gi, '').replace(/@import url\([^)]*\);?/g, '');
  return src.length > maxChars ? `${src.slice(0, maxChars)}\n<!-- …truncated -->` : src;
}

/** Names already installed in the scratch dir (for tests/diagnostics). */
export function installedReferences() {
  const dirs = [join(REF_DIR, 'compositions'), join(REF_DIR, 'compositions', 'components')];
  return dirs.flatMap(d => (existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, '')) : []));
}
