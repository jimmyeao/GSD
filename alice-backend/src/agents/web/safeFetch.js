/**
 * SSRF-safe HTTP GET for fetching arbitrary, model-chosen URLs.
 *
 * Alice runs on a LAN next to mail, Docker, ComfyUI and the LLM gateway, so a
 * URL the model (or a prompt-injected page) picks must never reach them.
 * Defences:
 *   - http/https only, no credentials in the URL
 *   - every address a hostname resolves to is checked, INSIDE the socket's DNS
 *     lookup — so the checked IP is the connected IP (no DNS-rebinding gap)
 *   - redirects are followed manually and re-validated at every hop
 *   - hard caps on redirects, time and bytes
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AliceBot/1.0; +local assistant)';

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT (Tailscale lives here)
      || (a === 169 && b === 254)             // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)               // 192.0.0.0/24, 192.0.2.0/24
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0)
      || a >= 224;                            // multicast + reserved + broadcast
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16);
      return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return /^(fc|fd)/.test(v)                 // unique local
      || /^fe[89ab]/.test(v)                  // link-local
      || /^ff/.test(v)                        // multicast
      || v.startsWith('64:ff9b:')             // NAT64
      || v.startsWith('2001:db8');            // documentation
  }
  return true; // not an IP at all — refuse
}

/** Throw unless `raw` is a plain public-looking http(s) URL. Returns the parsed URL. */
export function assertFetchableUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('Not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not reachable from the public internet');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('That address is not reachable from the public internet');
  return u;
}

/** DNS lookup that refuses any private result. Used as the socket's `lookup`. */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    const bad = list.find(a => isPrivateAddress(a.address));
    if (bad) return callback(new Error('That address is not reachable from the public internet'));
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function requestOnce(url, { timeoutMs, maxBytes, accept, lookup }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'en-GB,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).toString() });
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      const finish = () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated, url: url.toString() });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', (e) => (truncated ? finish() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a public URL with SSRF protection.
 * @returns {Promise<{status:number, headers:object, body:Buffer, truncated:boolean, url:string}>}
 */
export async function safeGet(rawUrl, opts = {}) {
  const o = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    lookup: opts.lookup ?? safeLookup, // overridable in tests only
  };
  let url = assertFetchableUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await requestOnce(url, o);
    if (!r.redirect) return r;
    url = assertFetchableUrl(r.redirect);
  }
  throw new Error('Too many redirects');
}
