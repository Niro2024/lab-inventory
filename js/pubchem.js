// PubChem lookups: name/CAS -> formula, CAS, synonyms, GHS pictograms.
// The parse* functions are pure so they can be tested on recorded responses.
import { isValidCas, normalizeCas } from './cas.js';

const API = 'https://pubchem.ncbi.nlm.nih.gov/rest';

export function parseProperties(json) {
  const p = json?.PropertyTable?.Properties?.[0];
  return p ? { cid: p.CID, formula: p.MolecularFormula || '', title: p.Title || '', iupac: p.IUPACName || '' } : null;
}

export function parseSynonyms(json, max = 15) {
  const all = json?.InformationList?.Information?.[0]?.Synonym || [];
  const cas = all.find(s => /^\d{2,7}-\d{2}-\d$/.test(s) && isValidCas(s)) || '';
  // keep short, human-looking names; drop registry codes like "UNII-ND2M416302"
  const names = all.filter(s => s !== cas && s.length <= 40 && !/^[A-Z0-9]+[-_][A-Z0-9-]{5,}$/.test(s)
    && !/^\d{2,7}-\d{2}-\d$/.test(s));
  return { cas, synonyms: names.slice(0, max) };
}

// GHS: PubChem lists several sources; the first record is the curated summary.
export function parseGhs(json) {
  const out = { pictograms: [], hazards: [], signal: '' };
  const infos = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.Name && o.Value) infos.push(o);
      Object.values(o).forEach(walk);
    }
  })(json?.Record?.Section);
  const firstRef = infos.find(i => i.Name === 'Pictogram(s)')?.ReferenceNumber;
  for (const i of infos) {
    if (firstRef !== undefined && i.ReferenceNumber !== firstRef) continue;
    const swm = i.Value.StringWithMarkup || [];
    if (i.Name === 'Pictogram(s)') {
      for (const s of swm) for (const m of s.Markup || []) if (m.Type === 'Icon' && m.Extra) out.pictograms.push(m.Extra);
    } else if (i.Name === 'Signal') {
      out.signal ||= swm[0]?.String || '';
    } else if (i.Name === 'GHS Hazard Statements') {
      for (const s of swm) { const h = /^(H\d{3}[A-Za-z]*)/.exec(s.String); if (h) out.hazards.push(h[1]); }
    }
  }
  out.pictograms = [...new Set(out.pictograms)];
  out.hazards = [...new Set(out.hazards)];
  return out;
}

export const safetyUrl = cid => `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Safety-and-Hazards`;

const getJson = async (url, fetchFn) => {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`PubChem ${r.status}`);
  return r.json();
};

// Look up by CAS (preferred, unambiguous) or name. Returns null when not found.
export async function lookup({ name, cas }, fetchFn = fetch) {
  const q = cas && isValidCas(cas) ? normalizeCas(cas) : String(name || '').trim();
  if (!q) return null;
  let props;
  try {
    props = parseProperties(await getJson(`${API}/pug/compound/name/${encodeURIComponent(q)}/property/MolecularFormula,IUPACName,Title/JSON`, fetchFn));
  } catch { return null; }
  if (!props) return null;
  const [syn, ghs] = await Promise.all([
    getJson(`${API}/pug/compound/cid/${props.cid}/synonyms/JSON`, fetchFn).then(parseSynonyms).catch(() => ({ cas: '', synonyms: [] })),
    getJson(`${API}/pug_view/data/compound/${props.cid}/JSON?heading=GHS+Classification`, fetchFn).then(parseGhs)
      .catch(() => ({ pictograms: [], hazards: [], signal: '' })),
  ]);
  return {
    cid: props.cid, title: props.title, formula: props.formula,
    cas: syn.cas, synonyms: syn.synonyms,
    ghs: [...ghs.pictograms, ...ghs.hazards], signal: ghs.signal,
    sds_url: safetyUrl(props.cid),
  };
}
