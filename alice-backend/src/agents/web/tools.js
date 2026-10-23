/**
 * Web tools for WebAgent — all read-only.
 *
 *   get_weather   Open-Meteo (no API key)
 *   get_news      BBC RSS by category (no key); other topics go to Brave News
 *   web_search    Brave Search API (BRAVE_API_KEY)
 *   read_url      fetch a page + extract the article text (SSRF-guarded)
 *
 * Results are small JSON objects. Anything that came from a third-party page
 * is marked `untrusted` — the agent's prompt tells the model never to follow
 * instructions found inside it.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML, DOMParser } from 'linkedom';
import { safeGet } from './safeFetch.js';

const BRAVE_BASE = 'https://api.search.brave.com/res/v1';
const MAX_ARTICLE_CHARS = 6000;
const API_TIMEOUT_MS = 10_000;

// ── Tool catalogue (OpenAI function-call format) ───────────────────────

export const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather and a 3-day forecast for a place. Temperatures in °C, wind in mph.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Town or city, e.g. "London" or "Leeds, UK".' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: 'Latest headlines. Use a category (top, uk, world, business, technology, science, health) for general news, or any other topic string to search recent news on it.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'A category or a free-text topic. Omit for top UK headlines.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, URLs and snippets. Follow up with read_url to read a result in full.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from this period. Omit for any time.' },
          count: { type: 'integer', description: 'Number of results, 1-10 (default 5).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: 'Fetch a web page and return its main article text (trimmed). Use for URLs the user gave you or ones found by web_search/get_news.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL.' } },
        required: ['url'],
      },
    },
  },
];

// ── Weather ────────────────────────────────────────────────────────────

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};
export const describeWeatherCode = (c) => WMO[c] ?? 'unknown conditions';

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.json();
}

export async function getWeather({ location }) {
  const q = String(location ?? '').trim();
  if (!q) throw new Error('location is required');
  // Open-Meteo's geocoder matches a bare name best: "Leeds, UK" → "Leeds".
  const [name, ...rest] = q.split(',').map(s => s.trim());
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`);
  const hint = rest.join(' ').toLowerCase();
  const hit = (geo.results ?? []).find(r => hint && `${r.country} ${r.country_code} ${r.admin1 ?? ''}`.toLowerCase().includes(hint)) ?? geo.results?.[0];
  if (!hit) throw new Error(`Couldn't find a place called "${q}"`);

  const f = await getJson('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: hit.latitude, longitude: hit.longitude, timezone: 'auto', forecast_days: '3', wind_speed_unit: 'mph',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset',
  }));
  const c = f.current ?? {};
  const d = f.daily ?? {};
  return {
    place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
    local_time: c.time,
    now: {
      conditions: describeWeatherCode(c.weather_code),
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      rain_mm: c.precipitation,
      wind_mph: c.wind_speed_10m,
      gusts_mph: c.wind_gusts_10m,
    },
    forecast: (d.time ?? []).map((day, i) => ({
      date: day,
      conditions: describeWeatherCode(d.weather_code?.[i]),
      high_c: d.temperature_2m_max?.[i],
      low_c: d.temperature_2m_min?.[i],
      rain_chance_pct: d.precipitation_probability_max?.[i],
      rain_mm: d.precipitation_sum?.[i],
      sunrise: d.sunrise?.[i]?.slice(11),
      sunset: d.sunset?.[i]?.slice(11),
    })),
    source: 'Open-Meteo',
  };
}

// ── News ───────────────────────────────────────────────────────────────

const BBC = 'https://feeds.bbci.co.uk/news';
export const NEWS_FEEDS = {
  top: `${BBC}/rss.xml`,
  uk: `${BBC}/uk/rss.xml`,
  world: `${BBC}/world/rss.xml`,
  business: `${BBC}/business/rss.xml`,
  technology: `${BBC}/technology/rss.xml`,
  science: `${BBC}/science_and_environment/rss.xml`,
  health: `${BBC}/health/rss.xml`,
};

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');
const textOf = (el, tag) => el.querySelector(tag)?.textContent?.trim() ?? '';

/** Parse an RSS 2.0 / Atom document into [{title, summary, url, published}]. */
export function parseFeed(xml, limit = 8) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = [...doc.querySelectorAll('item')];
  const entries = items.length ? items : [...doc.querySelectorAll('entry')];
  return entries.slice(0, limit).map(it => ({
    title: textOf(it, 'title'),
    summary: clip(textOf(it, 'description') || textOf(it, 'summary'), 240),
    url: textOf(it, 'link') || it.querySelector('link')?.getAttribute('href') || '',
    published: textOf(it, 'pubDate') || textOf(it, 'updated'),
  })).filter(i => i.title && i.url);
}

export async function getNews({ topic } = {}) {
  const key = String(topic ?? 'top').trim().toLowerCase() || 'top';
  const feed = NEWS_FEEDS[key] ?? NEWS_FEEDS[{ headlines: 'top', 'uk news': 'uk', tech: 'technology' }[key]];
  if (feed) {
    const r = await safeGet(feed, { accept: 'application/rss+xml,application/xml,text/xml', timeoutMs: API_TIMEOUT_MS });
    if (r.status !== 200) throw new Error(`BBC feed returned ${r.status}`);
    return { topic: key, source: 'BBC News', untrusted: true, items: parseFeed(r.body.toString('utf8')) };
  }
  // Free-text topic → Brave News (needs the key).
  const res = await braveGet('/news/search', { q: String(topic), count: '8', country: 'GB', freshness: 'pw' });
  return {
    topic: String(topic), source: 'Brave News', untrusted: true,
    items: (res.results ?? []).slice(0, 8).map(r => ({
      title: r.title, summary: clip(stripTags(r.description), 240), url: r.url, published: r.age ?? r.page_age ?? '',
      outlet: r.meta_url?.hostname ?? '',
    })),
  };
}

// ── Search ─────────────────────────────────────────────────────────────

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

async function braveGet(path, params) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('Web search is not configured (BRAVE_API_KEY is not set on the server).');
  return getJson(`${BRAVE_BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
}

const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export async function webSearch({ query, freshness, count }) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query is required');
  const n = Math.min(Math.max(parseInt(count ?? 5, 10) || 5, 1), 10);
  const params = { q, count: String(n), country: 'GB', safesearch: 'moderate', text_decorations: 'false' };
  if (FRESHNESS[freshness]) params.freshness = FRESHNESS[freshness];
  const res = await braveGet('/web/search', params);
  return {
    query: q, untrusted: true,
    results: (res.web?.results ?? []).slice(0, n).map(r => ({
      title: stripTags(r.title), url: r.url, snippet: clip(stripTags(r.description), 300), age: r.age ?? '',
    })),
  };
}

// ── Read a page ────────────────────────────────────────────────────────

export function extractArticle(html, url) {
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 200 }).parse();
  // textContent glues paragraphs together ("2018.In a statement"); break on block ends first.
  const withBreaks = article?.content
    ? parseHTML(`<html><body>${article.content.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, '$&\n')}</body></html>`).document.body?.textContent ?? ''
    : document.body?.textContent ?? '';
  const text = withBreaks.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    url,
    title: article?.title || document.title || '',
    byline: article?.byline || '',
    text,
  };
}

export async function readUrl({ url }) {
  const r = await safeGet(url, { maxBytes: 2_000_000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`The page returned HTTP ${r.status}`);
  const type = String(r.headers['content-type'] || '').toLowerCase();
  if (/application\/pdf/.test(type)) throw new Error('That is a PDF — reading PDFs is not supported yet.');
  if (type && !/text\/|html|xml|json/.test(type)) throw new Error(`Can't read that kind of content (${type.split(';')[0]}).`);
  const body = r.body.toString('utf8');
  const page = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body) ? extractArticle(body, r.url) : { url: r.url, title: '', byline: '', text: body.trim() };
  if (!page.text) throw new Error('No readable text found on that page (it may need JavaScript).');
  return {
    url: page.url, title: page.title, byline: page.byline, untrusted: true,
    text: clip(page.text, MAX_ARTICLE_CHARS),
    truncated: page.text.length > MAX_ARTICLE_CHARS || r.truncated,
  };
}

// ── Dispatcher ─────────────────────────────────────────────────────────

const HANDLERS = { get_weather: getWeather, get_news: getNews, web_search: webSearch, read_url: readUrl };

/** Run one tool. Never throws — errors come back as {error} for the model to relay. */
export async function runWebTool(name, args) {
  const fn = HANDLERS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(args ?? {});
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
