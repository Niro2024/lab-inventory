// Unit tests, run in the browser by tests/index.html (no Node needed).
import { isValidCas, normalizeCas } from '../js/cas.js';
import { searchItems, scoreItem } from '../js/search.js';
import { STRINGS } from '../js/i18n.js';
import { parseProperties, parseSynonyms, parseGhs, lookup } from '../js/pubchem.js';
import { exportRows, EXPORT_COLUMNS } from '../js/export.js';
import { createDb, mockBackend, shelfPath } from '../js/db.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg); };
const fixture = p => fetch(`fixtures/${p}`).then(r => r.json());
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

// ---- CAS ----
test('CAS: valid numbers pass the checksum', () => {
  for (const c of ['67-63-0', '1310-58-3', '16961-25-4', '10101-97-0', '87-69-4', '64-17-5', '7732-18-5']) ok(isValidCas(c), c);
});
test('CAS: a single misread digit fails the checksum', () => {
  for (const c of ['67-63-1', '1310-58-4', '16961-52-4', '64-71-5']) ok(!isValidCas(c), c);
});
test('CAS: normalizes missing dashes and spaces', () => {
  eq(normalizeCas('67630'), '67-63-0');
  eq(normalizeCas(' 1310 58 3 '), '1310-58-3');
  ok(!isValidCas('abc'));
});
test('CAS: every label fixture carries a valid CAS', async () => {
  for (const k of ['isopropanol', 'koh', 'haucl4', 'niso4', 'tartaric', 'ethanol']) {
    const { expected } = await fixture(`labels/${k}.json`);
    ok(isValidCas(expected.cas), `${k} ${expected.cas}`);
  }
});

// ---- PubChem parsing (recorded responses) ----
test('PubChem: properties', async () => {
  const p = parseProperties(await fixture('pubchem/isopropanol_properties.json'));
  eq(p.cid, 3776); eq(p.formula, 'C3H8O'); eq(p.title, 'Isopropanol');
});
test('PubChem: synonyms yield CAS and human names', async () => {
  const s = parseSynonyms(await fixture('pubchem/isopropanol_synonyms.json'));
  eq(s.cas, '67-63-0');
  ok(s.synonyms.includes('isopropanol') && s.synonyms.includes('2-Propanol'), s.synonyms.join('|'));
  ok(!s.synonyms.includes('67-63-0'));
  ok(s.synonyms.length <= 15);
});
test('PubChem: GHS from the first (summary) record only', async () => {
  const g = parseGhs(await fixture('pubchem/isopropanol_ghs.json'));
  eq(g.signal, 'Danger');
  ok(g.pictograms.includes('Flammable') && g.pictograms.includes('Irritant'), g.pictograms.join());
  ok(!g.pictograms.includes('Corrosive'), 'must not mix in other records: ' + g.pictograms.join());
  ok(g.hazards.includes('H225') && g.hazards.includes('H319'), g.hazards.join());
});
test('PubChem: lookup() combines the three calls', async () => {
  const files = { property: 'properties', synonyms: 'synonyms', pug_view: 'ghs' };
  const fakeFetch = async url => {
    const k = Object.keys(files).find(x => url.includes(x));
    return { ok: true, json: () => fixture(`pubchem/isopropanol_${files[k]}.json`) };
  };
  const r = await lookup({ name: 'isopropanol' }, fakeFetch);
  eq(r.cas, '67-63-0'); eq(r.formula, 'C3H8O'); ok(r.ghs.includes('H225')); ok(r.sds_url.includes('/compound/3776'));
  eq(await lookup({ name: '' }, fakeFetch), null);
  eq(await lookup({ name: 'nothing' }, async () => ({ ok: false, status: 404 })), null);
});

// ---- search ----
async function sampleItems() {
  const s = parseSynonyms(await fixture('pubchem/isopropanol_synonyms.json'));
  return [
    { id: 'a', type: 'chemical', name: '2-Propanol', cas: '67-63-0', formula: 'C3H8O', synonyms: s.synonyms, status: 'active' },
    { id: 'b', type: 'chemical', name: 'Ethanol absolute', cas: '64-17-5', formula: 'C2H6O', synonyms: ['ethanol'], status: 'active' },
    { id: 'c', type: 'chemical', name: 'Potassium hydroxide', cas: '1310-58-3', formula: 'KOH', synonyms: [], status: 'active' },
    { id: 'd', type: 'sample', name: '5 nm gold nanoparticles', sender: 'Thomas', synonyms: [], status: 'active' },
    { id: 'e', type: 'chemical', name: 'Isopropanol (old bottle)', cas: '67-63-0', synonyms: [], status: 'used_up' },
  ];
}
test('search: "isoprop", "IPA", "67-63-0", "C3H8O" all put isopropanol first', async () => {
  const items = await sampleItems();
  for (const q of ['isoprop', 'IPA', '67-63-0', '67630', 'C3H8O', 'isopropyl alcohol']) {
    eq(searchItems(q, items)[0]?.id, 'a', `query "${q}"`);
  }
});
test('search: tolerates a typo', async () => {
  eq(searchItems('isopropnol', await sampleItems())[0]?.id, 'a');
  eq(searchItems('potasium hydroxid', await sampleItems())[0]?.id, 'c');
});
test('search: samples by sender and description; type filter', async () => {
  const items = await sampleItems();
  eq(searchItems('Thomas', items)[0]?.id, 'd');
  eq(searchItems('gold', items)[0]?.id, 'd');
  eq(searchItems('gold', items, { type: 'chemical' }).length, 0);
  eq(searchItems('', items, { type: 'sample' }).map(i => i.id), ['d']);
});
test('search: used-up items hidden unless asked; no junk matches', async () => {
  const items = await sampleItems();
  ok(!searchItems('67-63-0', items).some(i => i.id === 'e'));
  ok(searchItems('67-63-0', items, { includeUsed: true }).some(i => i.id === 'e'));
  eq(searchItems('xyzzy', items).length, 0);
  eq(scoreItem('KOH', items[2]) > scoreItem('KOH', items[0]), true);
});

// ---- i18n ----
test('i18n: every English key has a Hebrew translation and vice versa', () => {
  const en = Object.keys(STRINGS.en), he = Object.keys(STRINGS.he);
  eq(en.filter(k => !he.includes(k)), [], 'missing in he:');
  eq(he.filter(k => !en.includes(k)), [], 'missing in en:');
  for (const k of en) eq(typeof STRINGS.he[k], typeof STRINGS.en[k], `type of ${k}`);
});
test('i18n: every t() key used in app.js exists', async () => {
  const src = await fetch('../js/app.js').then(r => r.text());
  const used = [...src.matchAll(/\bt\('([A-Za-z_]+)'/g)].map(m => m[1]);
  const dynamic = ['ev_add', 'ev_edit', 'ev_move', 'ev_used_up', 'ev_restore',
    ...['cabinet', 'fridge', 'freezer', 'flammables', 'acid', 'glovebox', 'other'].map(k => `kind_${k}`)];
  const missing = [...new Set([...used, ...dynamic])].filter(k => !(k in STRINGS.en));
  eq(missing, [], 'unknown keys:');
});

// ---- database logic on the mock backend ----
test('db: add / move / used up / restore are all logged with who and when', async () => {
  const db = createDb(mockBackend(memStore()));
  const r = await db.addRoom('Chem room'); const u = await db.addUnit(r.id, 'Upper right', 'cabinet');
  const s1 = await db.addShelf(u.id, 'Shelf 1'); const s2 = await db.addShelf(u.id, 'Shelf 2');
  const it = await db.addItem({ name: '2-Propanol', cas: '67-63-0', shelf_id: s1.id }, 'Nir');
  eq(it.added_by, 'Nir'); eq(it.status, 'active'); ok(it.created_at);
  await db.moveItem(it.id, s2.id, 'Dana');
  await db.markUsedUp(it.id, 'Nir');
  await db.restore(it.id, 'Nir');
  const h = await db.history(it.id);
  eq(h.map(e => e.action), ['add', 'move', 'used_up', 'restore']);
  eq(h[1].by, 'Dana'); eq(h[1].details, { from: s1.id, to: s2.id });
  ok(h.every(e => e.at));
  const loc = await db.locations();
  eq(shelfPath(loc, s2.id), 'Chem room › Upper right › Shelf 2');
  eq((await db.item(it.id)).shelf_id, s2.id);
});
test('db: nothing can be deleted', () => {
  const be = mockBackend(memStore()); const db = createDb(be);
  ok(!('delete' in be) && !('remove' in be));
  ok(!Object.keys(db).some(k => /delete|remove/i.test(k)), Object.keys(db).join());
});
test('db: members are de-duplicated, empty names rejected', async () => {
  const db = createDb(mockBackend(memStore()));
  await db.addMember('Nir'); await db.addMember('nir'); await db.addMember('Thomas');
  eq((await db.members()).map(m => m.name), ['Nir', 'Thomas']);
  let threw = false; try { await db.addRoom('  '); } catch { threw = true; }
  ok(threw, 'empty room name must be rejected');
});
test('db: samples keep sender and date', async () => {
  const db = createDb(mockBackend(memStore()));
  const s = await db.addItem({ type: 'sample', name: '5 nm gold', sender: 'Thomas', added_by: 'Nir' });
  eq(s.type, 'sample'); eq(s.sender, 'Thomas'); eq(s.added_by, 'Nir');
  eq(s.created_at.slice(0, 10), new Date().toISOString().slice(0, 10));
});

// ---- export ----
test('export: one row per item with fixed columns and readable location', async () => {
  const db = createDb(mockBackend(memStore()));
  const r = await db.addRoom('Room A'); const u = await db.addUnit(r.id, 'Fridge', 'fridge'); const s = await db.addShelf(u.id, 'Top');
  await db.addItem({ name: 'KOH', ghs: ['Corrosive', 'H314'], shelf_id: s.id, quantity: 500, unit: 'g' }, 'Nir');
  const rows = exportRows(await db.items(), await db.locations());
  eq(rows.length, 1); eq(Object.keys(rows[0]), EXPORT_COLUMNS);
  eq(rows[0].Location, 'Room A › Fridge › Top'); eq(rows[0].GHS, 'Corrosive, H314'); eq(rows[0].Quantity, 500);
  eq(rows[0].Status, 'active');
});

// ---- runner ----
const out = document.getElementById('out');
const results = [];
for (const { name, fn } of tests) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}
const failed = results.filter(r => !r.pass);
out.innerHTML = `<h1>${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} passed</h1>` +
  results.map(r => `<div class="${r.pass ? 'p' : 'f'}">${r.pass ? '✓' : '✗'} ${r.name}${r.error ? `<pre>${r.error}</pre>` : ''}</div>`).join('');
window.__testResults = { total: results.length, failed };
