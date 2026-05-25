/**
 * RFC 2369 / RFC 8058 unsubscribe helper.
 *
 * Parses `List-Unsubscribe` and `List-Unsubscribe-Post` off an already-fetched
 * message and either performs the unsubscribe (one-click POST or mailto send)
 * or returns guidance for a manual link.
 *
 * Security:
 *   - http(s) schemes only — no javascript:, file:, data:, etc.
 *   - Rejects localhost, loopback, and RFC1918 private ranges so the server
 *     can't be tricked into hitting internal services.
 *   - 15 second timeout and redirect:'follow' (fetch follows up to ~20 hops).
 *   - No custom cookies / auth headers; a generic User-Agent only.
 *   - Never throws from runUnsubscribe — all errors map to { result:'failed' }.
 */

const UA = 'Mozilla/5.0 (compatible; AliceMailAgent/1.0)';
const TIMEOUT_MS = 15_000;

// ── Header parsing ─────────────────────────────────────────────────────

/**
 * Parse a List-Unsubscribe header value into { url, mailto }.
 *   Example: "<https://u.acme.com/u?x=1>, <mailto:leave@acme.com>"
 */
export function parseListUnsubscribe(raw) {
  const out = { url: null, mailto: null };
  if (!raw || typeof raw !== 'string') return out;
  // Extract every <...> entry.
  const entries = [];
  const re = /<([^>]+)>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    entries.push(m[1].trim());
  }
  // Fallback: unbracketed single value.
  if (entries.length === 0) {
    const trimmed = raw.trim();
    if (trimmed) entries.push(trimmed);
  }
  for (const e of entries) {
    if (!out.mailto && /^mailto:/i.test(e)) {
      out.mailto = e.replace(/^mailto:/i, '').split('?')[0].trim() || null;
    } else if (!out.url && /^https?:\/\//i.test(e)) {
      out.url = e;
    }
  }
  return out;
}

/** True if List-Unsubscribe-Post indicates RFC 8058 one-click. */
export function isOneClickPost(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'list-unsubscribe=one-click';
}

/**
 * Given a message.headers map (case-variant keys possible), extract a
 * convenience object: { url, mailto, oneClick }.
 */
export function extractListUnsubscribe(headers) {
  const lu = _pickHeader(headers, 'list-unsubscribe');
  const lup = _pickHeader(headers, 'list-unsubscribe-post');
  const parsed = parseListUnsubscribe(lu);
  return {
    url: parsed.url,
    mailto: parsed.mailto,
    oneClick: isOneClickPost(lup),
  };
}

function _pickHeader(headers, lowerName) {
  if (!headers || typeof headers !== 'object') return null;
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === lowerName) return headers[k];
  }
  return null;
}

// ── URL / hostname safety ──────────────────────────────────────────────

const PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1']);

function isPrivateIPv4(host) {
  // Very small RFC1918 / loopback guard. We only trust numeric IPv4 dots here.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(n => Number(n));
  if (o.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  if (o[0] === 10) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 0) return true;
  return false;
}

/** Returns the safe URL if acceptable, otherwise throws. */
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); }
  catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${u.protocol}`);
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) throw new Error('URL has no host');
  if (PRIVATE_HOSTS.has(host)) throw new Error('URL host is not allowed');
  if (host.endsWith('.localhost')) throw new Error('URL host is not allowed');
  if (isPrivateIPv4(host)) throw new Error('URL host is not allowed');
  // Bracketed IPv6 literal — reject wholesale; real unsubscribe links use DNS.
  if (host.includes(':')) throw new Error('IPv6 hosts are not allowed');
  return u;
}

// ── Strategy picking ───────────────────────────────────────────────────

/**
 * Pure function — decide which unsubscribe strategy to use.
 *   Returns { method: 'one_click'|'mailto'|'web_link'|'none', target: string|null, source?: 'header'|'body' }.
 */
export function chooseStrategy(message) {
  const ext = message?.listUnsubscribe || extractListUnsubscribe(message?.headers || {});
  if (ext.url && ext.oneClick) {
    return { method: 'one_click', target: ext.url, source: 'header' };
  }
  if (ext.mailto) {
    return { method: 'mailto', target: ext.mailto, source: 'header' };
  }
  if (ext.url) {
    return { method: 'web_link', target: ext.url, source: 'header' };
  }
  // Fallback: scan the body for an unsubscribe-like anchor.
  const bodyLink = findBodyUnsubscribeLink(message);
  if (bodyLink) {
    return { method: 'web_link', target: bodyLink, source: 'body' };
  }
  return { method: 'none', target: null };
}

/**
 * Scan message.body_html for anchors whose text or href suggests unsubscribe.
 * Returns the best-scoring http(s) URL, or null.
 * This is a last-resort heuristic — many senders omit the RFC header even
 * though they include an unsubscribe link in the body.
 */
export function findBodyUnsubscribeLink(message) {
  const html = message?.body_html || '';
  if (!html || typeof html !== 'string') return null;
  const anchors = [];
  // <a ... href="..."> inner </a>  — capture href via three quoting styles.
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] || m[2] || m[3] || '').trim();
    if (!/^https?:\/\//i.test(href)) continue;
    // Strip tags and normalise whitespace in the anchor text.
    const text = m[4].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    anchors.push({ href, text });
  }
  if (!anchors.length) return null;
  const scored = anchors
    .map(a => ({ ...a, score: _scoreAnchor(a) }))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.href || null;
}

function _scoreAnchor({ href, text }) {
  let score = 0;
  const t = (text || '').toLowerCase();
  const h = (href || '').toLowerCase();
  // Anchor text matches — strongest signal.
  if (/\bunsubscribe\b/.test(t)) score += 10;
  if (/\bopt[\s-]?out\b/.test(t)) score += 8;
  if (/\bstop receiving\b/.test(t)) score += 7;
  if (/\bremove me\b/.test(t)) score += 6;
  if (/manage[^<]{0,40}(email|subscription|preferences)/.test(t)) score += 4;
  if (/update[^<]{0,40}preferences/.test(t)) score += 3;
  // URL contains the intent word.
  if (/unsubscribe/.test(h)) score += 5;
  if (/opt[_-]?out/.test(h)) score += 3;
  if (/\bremove\b/.test(h) && /email|list|sub/.test(h)) score += 2;
  return score;
}

// ── Executor ───────────────────────────────────────────────────────────

/**
 * Execute the unsubscribe. Returns { method, result, details } and never
 * throws. `result ∈ {'done','manual','failed'}`.
 */
export async function runUnsubscribe({ message, provider, account, accessToken }) {
  const strat = chooseStrategy(message);

  if (strat.method === 'none') {
    return {
      method: 'none',
      result: 'failed',
      details: 'No unsubscribe method found in this email.',
    };
  }

  if (strat.method === 'web_link') {
    try {
      const url = assertSafeUrl(strat.target);
      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          // Browser-ish UA — some providers block obviously-automated UAs.
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      const status = resp.status;
      const ok = status >= 200 && status < 400;
      let finalHost = url.hostname;
      try { finalHost = new URL(resp.url).hostname; } catch { /* ignore */ }
      let body = '';
      try { body = (await resp.text()).slice(0, 8000); } catch { /* ignore */ }
      const lower = body.toLowerCase();
      const looksDone = /(you(?:['’]ve| have)?\s+(?:been\s+)?unsubscribed|you\s+(?:are|have\s+been)\s+removed|no\s+longer\s+receive|successfully\s+unsubscribed|unsubscribe\s+successful|email\s+(?:preferences\s+)?updated|removed\s+from\s+(?:our|this|the)\s+(?:list|mailing))/i.test(lower);
      const needsConfirm = ok && !looksDone
        && /<form\b/i.test(lower)
        && /(confirm|click\s+(?:here|the\s+button)|are\s+you\s+sure|yes,?\s+unsubscribe|submit)/i.test(lower);
      const bodySuffix = strat.source === 'body'
        ? ' (link came from message body, not RFC header)'
        : '';
      if (ok && looksDone) {
        return {
          method: 'web_link',
          result: 'done',
          details: `Visited ${finalHost} (HTTP ${status}) — page confirms unsubscribe${bodySuffix}.`,
          source: strat.source || 'header',
        };
      }
      if (needsConfirm) {
        return {
          method: 'web_link',
          result: 'manual',
          details: `Visited ${finalHost} (HTTP ${status}) but the page needs a confirmation click. Open this URL to finish: ${strat.target}${bodySuffix}`,
          source: strat.source || 'header',
        };
      }
      if (ok) {
        return {
          method: 'web_link',
          result: 'done',
          details: `Visited ${finalHost} (HTTP ${status}) — request accepted${bodySuffix}.`,
          source: strat.source || 'header',
        };
      }
      return {
        method: 'web_link',
        result: 'failed',
        details: `GET ${finalHost} returned ${status}${bodySuffix}`,
        source: strat.source || 'header',
      };
    } catch (err) {
      return {
        method: 'web_link',
        result: 'failed',
        details: `Request failed: ${err?.message || 'unknown error'}. You can still open the link manually: ${strat.target}`,
        source: strat.source || 'header',
      };
    }
  }

  if (strat.method === 'one_click') {
    try {
      const url = assertSafeUrl(strat.target);
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      const status = resp.status;
      const ok = (status >= 200 && status < 400);
      return {
        method: 'one_click',
        result: ok ? 'done' : 'failed',
        details: ok
          ? `POSTed to ${url.hostname} — server returned ${status}`
          : `POST to ${url.hostname} returned ${status}`,
      };
    } catch (err) {
      return {
        method: 'one_click',
        result: 'failed',
        details: `Request failed: ${err?.message || 'unknown error'}`,
      };
    }
  }

  if (strat.method === 'mailto') {
    try {
      if (!provider || typeof provider.sendMessage !== 'function') {
        throw new Error('provider missing sendMessage');
      }
      // RFC says the mailto address is literal. Validate shape.
      const addr = String(strat.target || '').trim();
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addr)) {
        throw new Error('invalid mailto address');
      }
      await provider.sendMessage(accessToken, {
        to: addr,
        subject: 'Unsubscribe',
        body: 'Please unsubscribe me from this list.',
        bodyType: 'text',
      });
      return {
        method: 'mailto',
        result: 'done',
        details: `Sent unsubscribe email to ${addr}`,
      };
    } catch (err) {
      return {
        method: 'mailto',
        result: 'failed',
        details: `Request failed: ${err?.message || 'unknown error'}`,
      };
    }
  }

  return {
    method: 'none',
    result: 'failed',
    details: 'Unknown strategy.',
  };
}
