// Client-side search over the inventory. A lab holds a few thousand items at most,
// so loading everything once and ranking in the browser is fast and identical for
// the mock and server backends.
import { normalizeCas } from './cas.js';

// Common lab shorthand -> names it should match.
export const ABBREVIATIONS = {
  ipa: ['isopropanol', '2-propanol', 'isopropyl alcohol'],
  etoh: ['ethanol'],
  meoh: ['methanol'],
  dmf: ['dimethylformamide', 'n,n-dimethylformamide'],
  dmso: ['dimethyl sulfoxide'],
  thf: ['tetrahydrofuran'],
  acn: ['acetonitrile'],
  mecn: ['acetonitrile'],
  dcm: ['dichloromethane'],
  etoac: ['ethyl acetate'],
  koh: ['potassium hydroxide'],
  naoh: ['sodium hydroxide'],
  pbs: ['phosphate buffered saline'],
  edta: ['ethylenediaminetetraacetic acid'],
  nmp: ['n-methyl-2-pyrrolidone'],
  pvdf: ['polyvinylidene fluoride'],
};

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function trigrams(s) {
  const t = new Set();
  const p = `  ${s} `;
  for (let i = 0; i < p.length - 2; i++) t.add(p.slice(i, i + 3));
  return t;
}

export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

// Score one text field against the query (0 = no match).
function scoreText(q, text) {
  const t = norm(text);
  if (!t || !q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 85;
  if (t.split(' ').some(w => w.startsWith(q))) return 80;
  if (t.includes(q)) return 70;
  // typo tolerance: best trigram similarity against whole text or any word
  const best = Math.max(similarity(q, t), ...t.split(' ').map(w => similarity(q, w)));
  return best >= 0.35 ? Math.round(60 * best) : 0;
}

export function scoreItem(query, item) {
  const raw = String(query || '').trim();
  if (!raw) return 1;
  const q = norm(raw);
  let score = 0;
  if (/^\d{2,7}-?\d{2}-?\d$/.test(raw) && item.cas && normalizeCas(raw) === normalizeCas(item.cas)) score = 120;
  if (item.formula && raw.replace(/\s/g, '').toLowerCase() === item.formula.replace(/\s/g, '').toLowerCase()) score = Math.max(score, 110);
  const names = [item.name, ...(item.synonyms || [])];
  for (const n of names) score = Math.max(score, scoreText(q, n));
  for (const n of ABBREVIATIONS[q] || []) {
    if (names.some(x => norm(x) === norm(n))) score = Math.max(score, 105);
  }
  // secondary fields count less
  for (const f of [item.sender, item.institution, item.notes, item.added_by, item.purity]) {
    score = Math.max(score, Math.round(scoreText(q, f) * 0.6));
  }
  if (item.cas && norm(item.cas).includes(q) && q.length >= 3) score = Math.max(score, 75);
  return score;
}

export function searchItems(query, items, { type = 'all', includeUsed = false } = {}) {
  return items
    .filter(it => includeUsed || it.status !== 'used_up')
    .filter(it => type === 'all' || it.type === type)
    .map(it => ({ it, s: scoreItem(query, it) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s || a.it.name.localeCompare(b.it.name))
    .map(r => r.it);
}
