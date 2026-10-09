/**
 * Code-level fact grounding for explainer plans.
 *
 * Prompt rules ("never invent offers") weren't enough: a BrewBuddy brief
 * that only gave a launch price came back with "Start your free trial" and
 * "10% off with code COFFEE10". This finds claims in a plan's text that the
 * brief/source material/answers don't support, so the planner can be asked
 * to fix them — and anything still unsupported is removed.
 *
 * Checked: tokens containing digits (prices, percentages, codes, counts)
 * and a list of common marketing claims. Prose claims without numbers can't
 * be verified this way; the prompt rule still covers those.
 */

const RISKY_PHRASES = [
  'free trial', 'trial', 'discount', '% off', 'percent off', 'promo code', 'coupon', 'voucher',
  'money-back', 'money back', 'guarantee', 'guaranteed', 'award-winning', 'award winning', 'number one', '#1',
  'certified', 'limited time', 'limited-time', 'lifetime', 'free shipping', 'free delivery', 'no credit card',
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/[“”"‘’']/g, '').replace(/\s+/g, ' ');

/** Text fields of a scene that can carry claims. */
function sceneTexts(s) {
  const out = [['speech', s.speech], ['headline', s.headline]];
  (s.bullets ?? []).forEach((b, k) => out.push([`bullets.${k}`, b]));
  (s.steps ?? []).forEach((b, k) => out.push([`steps.${k}`, b]));
  if (s.stat?.label) out.push(['stat.label', s.stat.label]);
  for (const side of ['left', 'right']) (s.compare?.[side] ?? []).forEach((b, k) => out.push([`compare.${side}.${k}`, b]));
  return out.filter(([, t]) => t);
}

/**
 * @returns {{scene: number, field: string, claim: string, text: string}[]}
 */
export function findUnsupportedClaims(plan, factsText) {
  const facts = norm(factsText);
  const factDigits = new Set(facts.match(/\d+(?:\.\d+)?/g) ?? []);
  const issues = [];
  plan.scenes.forEach((s, i) => {
    for (const [field, text] of sceneTexts(s)) {
      const t = norm(text);
      // Numbers / codes: "10%", "£59", "COFFEE10", "24/7", "3x"
      for (const tok of t.match(/[a-z]*\d[\w.%/]*/g) ?? []) {
        const digits = tok.match(/\d+(?:\.\d+)?/g) ?? [];
        const isCode = /[a-z]{2,}\d|\d[a-z]{2,}/.test(tok) && !/^\d+(st|nd|rd|th|s|x|k|m|gb|mb|tb|am|pm|min|mins|sec|secs|hrs?|px|fps|p)$/.test(tok);
        const supported = isCode ? facts.includes(tok) : digits.every(d => factDigits.has(d));
        if (!supported) issues.push({ scene: i, field, claim: tok, text });
      }
      for (const phrase of RISKY_PHRASES) {
        if (t.includes(phrase) && !facts.includes(phrase)) issues.push({ scene: i, field, claim: phrase, text });
      }
    }
  });
  // one entry per (scene, field, claim)
  const seen = new Set();
  return issues.filter(x => { const k = `${x.scene}|${x.field}|${x.claim}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function describeIssues(issues) {
  return issues.map(x => `- scene ${x.scene + 1} ${x.field}: "${x.claim}" (in: "${x.text}")`).join('\n');
}

/**
 * Last resort: remove unsupported claims. Bullets/steps/compare items are
 * dropped; in speech, the sentence containing the claim is dropped; a
 * headline/stat label is cleared. Returns a new plan (raw-shaped, for
 * normalizePlan to re-validate).
 */
export function scrubClaims(plan, issues) {
  const p = structuredClone(plan);
  for (const x of issues) {
    const s = p.scenes[x.scene];
    if (!s) continue;
    const [kind, a, b] = x.field.split('.');
    if (kind === 'speech') {
      s.speech = s.speech.split(/(?<=[.!?])\s+/).filter(sent => !norm(sent).includes(x.claim)).join(' ');
    } else if (kind === 'headline') {
      if (norm(s.headline).includes(x.claim)) s.headline = '';
    } else if (kind === 'bullets' || kind === 'steps') {
      s[kind] = s[kind].map((v, k) => (k === Number(a) && norm(v).includes(x.claim) ? null : v));
    } else if (kind === 'compare' && s.compare?.[a]) {
      s.compare[a] = s.compare[a].map((v, k) => (k === Number(b) && norm(v).includes(x.claim) ? null : v));
    } else if (kind === 'stat' && s.stat) {
      s.stat.label = '';
    }
  }
  for (const s of p.scenes) {
    for (const k of ['bullets', 'steps']) if (Array.isArray(s[k])) s[k] = s[k].filter(v => v !== null);
    if (s.compare) for (const side of ['left', 'right']) s.compare[side] = (s.compare[side] ?? []).filter(v => v !== null);
  }
  return p;
}
