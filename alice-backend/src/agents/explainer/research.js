/**
 * Source material for the explainer planner: the pages a brief links to,
 * and the images attached to it. Without this the planner only sees the
 * brief's words — a one-line brief pointing at a website produced a video
 * about an invented product (2026-10-05, theiacast.com → "AI audio").
 *
 * fetchSiteText() fetches user-supplied URLs, so it's SSRF-guarded: http(s)
 * only, every hostname is resolved and rejected if it points at a
 * loopback/private/link-local address, redirects are followed manually and
 * re-checked, responses are size- and time-capped.
 *
 * describeImages() asks the vision model (alice-vision — Laguna is text-only)
 * to classify each attachment as logo / screenshot / photo and describe it,
 * falling back to filename/aspect heuristics if vision is unavailable.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_EXTRA_PAGES = 3;
const MAX_SOURCE_CHARS = 9000;
const MAX_REDIRECTS = 4;
// Same-site pages worth reading for a product video, in priority order.
const USEFUL_PATHS = /\/(features?|product|how-it-works|about|solutions|use-cases|pricing|overview)\b/i;

export function extractUrls(text) {
  return [...new Set((String(text).match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).map(u => u.replace(/[.,;:!?]+$/, '')))].slice(0, 3);
}

/** True for addresses a server-side fetch must never reach. */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`not a valid URL: ${raw}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`only http(s) URLs are allowed: ${raw}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`refusing to fetch a private/internal address: ${url.hostname}`);
  return url;
}

async function fetchPublic(raw, fetchFn = fetch) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { 'User-Agent': 'AliceExplainer/1.0 (+brief research)', Accept: 'text/html,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw new Error(`${url.href} returned ${res.status}`);
    if (!/text\/html|xhtml/i.test(res.headers.get('content-type') ?? 'text/html')) throw new Error(`${url.href} is not an HTML page`);
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PAGE_BYTES) { reader.cancel(); break; }
      chunks.push(value);
    }
    return { url, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error(`too many redirects: ${raw}`);
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Readable text of a page: title, meta description, then body text. */
export function pageText(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
  const desc = decode(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i.exec(html)?.[1]
    ?? /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i.exec(html)?.[1] ?? '');
  const body = decode(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|br|tr)>/gi, '. ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s*\.\s*(\.\s*)+/g, '. ').replace(/\s+/g, ' ').trim();
  return [title && `Title: ${title}`, desc && `Description: ${desc}`, body].filter(Boolean).join('\n');
}

function sameSiteLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname === base.hostname && USEFUL_PATHS.test(u.pathname) && !out.includes(u.href)) out.push(u.href);
    } catch { /* ignore bad hrefs */ }
  }
  return out.slice(0, MAX_EXTRA_PAGES);
}

/**
 * Text of every URL in the brief (+ a few same-site product pages).
 * @returns {Promise<{text: string, sources: string[], errors: string[]}>}
 */
export async function researchBrief(brief, { fetchFn = fetch } = {}) {
  const sources = []; const errors = []; const parts = [];
  for (const start of extractUrls(brief)) {
    try {
      const home = await fetchPublic(start, fetchFn);
      sources.push(home.url.href);
      parts.push(`# ${home.url.href}\n${pageText(home.html)}`);
      for (const link of sameSiteLinks(home.html, home.url)) {
        try {
          const page = await fetchPublic(link, fetchFn);
          sources.push(page.url.href);
          parts.push(`# ${page.url.href}\n${pageText(page.html)}`);
        } catch (err) { errors.push(err.message); }
      }
    } catch (err) { errors.push(err.message); }
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_SOURCE_CHARS) text = `${text.slice(0, MAX_SOURCE_CHARS)}…`;
  return { text, sources, errors };
}

// ── Attached images ─────────────────────────────────────────────────────

export const IMAGE_KINDS = ['logo', 'screenshot', 'photo'];

function heuristicKind(name) {
  if (/logo|brand|icon|mark/i.test(name)) return 'logo';
  if (/screen|shot|capture|ui|app|dashboard/i.test(name)) return 'screenshot';
  return 'screenshot';
}

/**
 * Classify + describe attachments with the vision model.
 * @param {{id, name, dataUrl}[]} images
 * @param {{endpoint, model, apiKey?}} vision
 * @returns {Promise<{id, name, kind, description}[]>}
 */
export async function describeImages(images, vision, { fetchFn = fetch } = {}) {
  const out = [];
  for (const img of images) {
    let kind = heuristicKind(img.name);
    let description = '';
    try {
      const res = await fetchFn(`${vision.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(vision.apiKey ? { Authorization: `Bearer ${vision.apiKey}` } : {}) },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: vision.model, max_tokens: 400, temperature: 0.2,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Classify this image for use in a product video. Reply with ONLY JSON: {"kind": "logo" | "screenshot" | "photo", "description": "one sentence: what it shows, including any visible product name or UI"}' },
            { type: 'image_url', image_url: { url: img.dataUrl } },
          ] }],
        }),
      });
      if (res.ok) {
        const reply = (await res.json()).choices?.[0]?.message?.content ?? '';
        const json = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
        if (IMAGE_KINDS.includes(json.kind)) kind = json.kind;
        description = String(json.description ?? '').slice(0, 300);
      }
    } catch { /* keep heuristic */ }
    out.push({ id: img.id, name: img.name, kind, description });
  }
  return out;
}
