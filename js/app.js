import { CONFIG } from './config.js';
import { createDb, mockBackend, httpBackend, shelfPath } from './db.js';
import { searchItems } from './search.js';
import { isValidCas, normalizeCas } from './cas.js';
import { lookup } from './pubchem.js';
import { extractLabel, toJpeg } from './extract.js';
import { exportRows, downloadXlsx } from './export.js';
import { t, getLang, setLang } from './i18n.js';

// ---------- setup ----------
const params = new URLSearchParams(location.search);
// Demo mode when asked for, or when the page isn't served by the lab server (e.g. a static copy).
const serverUp = !params.has('mock') && await fetch('api/health').then(r => r.ok, () => false);
const MOCK = !serverUp;
const store = (() => { try { localStorage.setItem('_t', '1'); return localStorage; } catch { return null; } })();
const prefs = {
  get: k => { try { return store?.getItem(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { store?.setItem(k, v); } catch { /* ignore */ } },
};

let db;
if (MOCK) {
  const backend = mockBackend(store || { getItem: () => null, setItem() {} });
  if (params.get('mock') === 'reset') {
    backend.reset();
    params.set('mock', '1');
    history.replaceState(null, '', `?${params}${location.hash}`);
  }
  db = createDb(backend);
} else {
  db = createDb(httpBackend());
}
window.__db = db; // handy for debugging and the self-tests

const state = { loc: { rooms: [], units: [], shelves: [] }, members: [], items: [] };
const me = () => prefs.get('labinv-me') || '';

async function refresh() {
  [state.loc, state.members, state.items] = await Promise.all([db.locations(), db.members(), db.items()]);
}

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const main = () => document.getElementById('main');
// replaceChildren() would print null/false as text, so drop them first
const mount = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
const fmtDate = s => (s ? new Date(s).toLocaleDateString(getLang() === 'he' ? 'he-IL' : 'en-GB') : '');
const fmtTime = s => (s ? new Date(s).toLocaleString(getLang() === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');
const qty = i => (i.quantity ?? '') !== '' && i.quantity !== null ? `${i.quantity} ${i.unit || ''}`.trim() : '';
const UNITS = ['g', 'mg', 'kg', 'mL', 'L', 'µL', 'mmol', 'pcs'];
const KINDS = ['cabinet', 'fridge', 'freezer', 'flammables', 'acid', 'glovebox', 'other'];
const KIND_ICON = { cabinet: '🗄️', fridge: '🧊', freezer: '❄️', flammables: '🔥', acid: '⚗️', glovebox: '🧤', other: '📦' };

function toast(msg, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function requireMe() {
  if (me()) return me();
  toast(t('pickYourName'), 'err');
  document.getElementById('me-select')?.focus();
  return null;
}

// ---------- shared widgets ----------
function memberSelect({ id, value, onchange }) {
  const sel = h('select', { id, 'aria-label': t('whoAmI') },
    h('option', { value: '' }, t('chooseName')),
    state.members.map(m => h('option', { value: m.name, selected: m.name === value }, m.name)),
    h('option', { value: '__add' }, t('addMember')));
  const box = h('span', { class: 'member-picker' }, sel);
  sel.addEventListener('change', () => {
    if (sel.value !== '__add') return onchange?.(sel.value);
    sel.value = value || '';
    const inp = h('input', { placeholder: t('newMemberName'), 'aria-label': t('newMemberName') });
    const save = async () => {
      const name = inp.value.trim();
      if (!name) return;
      await db.addMember(name);
      await refresh();
      onchange?.(name);
      const fresh = memberSelect({ id, value: name, onchange });
      box.replaceWith(fresh);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    box.append(inp, h('button', { type: 'button', onclick: save }, t('add')));
    inp.focus();
  });
  return box;
}

function locationPicker(shelfId) {
  const { rooms, units, shelves } = state.loc;
  const cur = shelves.find(s => s.id === shelfId);
  const curUnit = cur && units.find(u => u.id === cur.unit_id);
  const room = h('select', { 'aria-label': t('room') });
  const unit = h('select', { 'aria-label': t('unit') });
  const shelf = h('select', { 'aria-label': t('shelf'), name: 'shelf' });
  const fill = (sel, list, val, label) => {
    sel.replaceChildren(h('option', { value: '' }, label), ...list.map(x => h('option', { value: x.id, selected: x.id === val },
      x.kind ? `${KIND_ICON[x.kind] || ''} ${x.name}` : x.name)));
  };
  const onRoom = (val) => { fill(unit, units.filter(u => u.room_id === room.value), val, t('unit')); onUnit(); };
  const onUnit = (val) => fill(shelf, shelves.filter(s => s.unit_id === unit.value), val, t('shelf'));
  fill(room, rooms, curUnit?.room_id, t('room'));
  room.addEventListener('change', () => onRoom());
  unit.addEventListener('change', () => onUnit());
  if (curUnit) { onRoom(curUnit.id); onUnit(cur.id); } else onRoom();
  return { el: h('div', { class: 'loc-picker' }, room, unit, shelf), value: () => shelf.value || null };
}

function itemCard(i, { actions } = {}) {
  return h('li', { class: `card ${i.status === 'used_up' ? 'used' : ''}` },
    h('a', { href: `#/item/${i.id}`, class: 'card-main' },
      h('div', { class: 'card-title' }, i.name,
        i.type === 'sample' ? h('span', { class: 'tag sample' }, t('sample')) : null,
        i.status === 'used_up' ? h('span', { class: 'tag used' }, t('usedUp')) : null),
      h('div', { class: 'card-meta' },
        [i.cas && `CAS ${i.cas}`, qty(i), i.purity, i.type === 'sample' && i.sender && `${t('from')} ${i.sender}`].filter(Boolean).join(' · ')),
      h('div', { class: 'card-sub' }, `📍 ${shelfPath(state.loc, i.shelf_id) || t('noLocation')}`,
        ' · ', `${i.added_by || '—'}, ${fmtDate(i.created_at)}`)),
    actions ? h('div', { class: 'card-actions' }, actions) : null);
}

function moveControl(item, after) {
  const wrap = h('div', { class: 'move-box' });
  const btn = h('button', { type: 'button', class: 'secondary', onclick: () => {
    const p = locationPicker(item.shelf_id);
    wrap.replaceChildren(p.el, h('button', { type: 'button', onclick: async () => {
      const who = requireMe(); if (!who) return;
      const to = p.value(); if (!to) return toast(t('chooseShelf'), 'err');
      await db.moveItem(item.id, to, who); await refresh(); toast(t('moved')); after();
    } }, t('confirmMove')));
  } }, t('move'));
  wrap.append(btn);
  return wrap;
}

const usedUpButton = (item, after) => h('button', { type: 'button', class: 'secondary', onclick: async () => {
  const who = requireMe(); if (!who) return;
  await db.markUsedUp(item.id, who); await refresh(); toast(t('markedUsedUp')); after();
} }, t('markUsedUp'));

// ---------- views ----------
function viewSearch() {
  const q = h('input', { id: 'q', type: 'search', placeholder: t('searchPlaceholder'), 'aria-label': t('search'),
    value: params.get('q') || sessionStorage.getItem('labinv-q') || '' });
  const type = h('select', { id: 'type-filter', 'aria-label': t('type') },
    h('option', { value: 'all' }, t('all')), h('option', { value: 'chemical' }, t('chemicals')), h('option', { value: 'sample' }, t('samples')));
  const used = h('input', { type: 'checkbox', id: 'show-used' });
  const list = h('ul', { class: 'cards', id: 'results' });
  const count = h('p', { class: 'muted', id: 'count' });
  const run = () => {
    try { sessionStorage.setItem('labinv-q', q.value); } catch { /* ignore */ }
    const res = searchItems(q.value, state.items, { type: type.value, includeUsed: used.checked });
    count.textContent = t('nResults', res.length);
    list.replaceChildren(...res.slice(0, 200).map(i => itemCard(i)));
  };
  q.addEventListener('input', run); type.addEventListener('change', run); used.addEventListener('change', run);
  mount(main(),
    h('section', { class: 'search-bar' }, q,
      h('div', { class: 'filters' }, type, h('label', {}, used, ' ', t('showUsedUp')))),
    state.items.length ? null : h('div', { class: 'empty' }, t('emptyInventory'), ' ',
      h('a', { href: '#/locations' }, t('setUpLocations')), ' · ', h('a', { href: '#/add' }, t('addMaterial'))),
    count, list);
  run();
  q.focus();
}

function viewShelf(id) {
  const s = state.loc.shelves.find(x => x.id === id);
  if (!s) return main().replaceChildren(h('p', { class: 'empty' }, t('shelfNotFound')));
  const u = state.loc.units.find(x => x.id === s.unit_id);
  const items = state.items.filter(i => i.shelf_id === id && i.status !== 'used_up')
    .sort((a, b) => a.name.localeCompare(b.name));
  const rerender = () => viewShelf(id);
  main().replaceChildren(
    h('h1', {}, `${KIND_ICON[u?.kind] || ''} ${shelfPath(state.loc, id)}`),
    h('div', { class: 'quick-add' },
      h('a', { class: 'button', href: `#/add?shelf=${id}` }, `📷 ${t('addMaterialHere')}`),
      h('a', { class: 'button secondary', href: `#/sample?shelf=${id}` }, `✉️ ${t('addSampleHere')}`)),
    h('p', { class: 'muted' }, t('nOnShelf', items.length)),
    h('ul', { class: 'cards' }, items.map(i => itemCard(i, { actions: [usedUpButton(i, rerender), moveControl(i, rerender)] }))));
}

function viewItem(id) {
  const i = state.items.find(x => x.id === id);
  if (!i) return main().replaceChildren(h('p', { class: 'empty' }, t('itemNotFound')));
  const rerender = () => viewItem(id);
  const row = (k, v) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) ? null
    : h('div', { class: 'kv' }, h('dt', {}, t(k)), h('dd', {}, v));
  const histBox = h('ol', { class: 'history' }, h('li', { class: 'muted' }, '…'));
  db.history(id).then(evs => histBox.replaceChildren(...evs.map(e => h('li', {},
    h('strong', {}, t(`ev_${e.action}`)), ` — ${e.by || '—'}, ${fmtTime(e.at)}`,
    e.action === 'move' ? ` (${shelfPath(state.loc, e.details?.from) || '—'} → ${shelfPath(state.loc, e.details?.to)})` : ''))));
  main().replaceChildren(
    h('h1', {}, i.name, i.type === 'sample' ? h('span', { class: 'tag sample' }, t('sample')) : null,
      i.status === 'used_up' ? h('span', { class: 'tag used' }, t('usedUp')) : null),
    h('div', { class: 'detail' },
      i.photo_url ? h('img', { src: i.photo_url, alt: t('labelPhoto'), class: 'photo' }) : null,
      h('dl', {},
        row('cas', i.cas && h('span', {}, i.cas, isValidCas(i.cas) ? '' : h('span', { class: 'warn' }, ` ⚠ ${t('casInvalid')}`))),
        row('formula', i.formula), row('quantity', qty(i)), row('purity', i.purity),
        row('ghs', (i.ghs || []).length ? h('span', {}, (i.ghs || []).map(g => h('span', { class: 'tag ghs' }, g))) : ''),
        row('sds', i.sds_url && h('a', { href: i.sds_url, target: '_blank', rel: 'noopener' }, t('openSafety'))),
        row('sender', i.sender), row('institution', i.institution),
        row('location', h('a', { href: `#/shelf/${i.shelf_id}` }, shelfPath(state.loc, i.shelf_id) || t('noLocation'))),
        row(i.type === 'sample' ? 'receivedBy' : 'addedBy', i.added_by), row('dateAdded', fmtDate(i.created_at)),
        row('synonyms', (i.synonyms || []).join(', ')), row('notes', i.notes))),
    h('div', { class: 'actions' },
      h('a', { class: 'button secondary', href: `#/edit/${i.id}` }, t('edit')),
      moveControl(i, rerender),
      i.status === 'used_up'
        ? h('button', { type: 'button', class: 'secondary', onclick: async () => {
          const who = requireMe(); if (!who) return;
          await db.restore(i.id, who); await refresh(); toast(t('restored')); rerender();
        } }, t('restore'))
        : usedUpButton(i, rerender)),
    h('h2', {}, t('history')), histBox);
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, t(label)), input, hint || null);
}

function viewChemicalForm({ editId } = {}) {
  const item = editId ? state.items.find(x => x.id === editId) : null;
  if (editId && !item) return main().replaceChildren(h('p', { class: 'empty' }, t('itemNotFound')));
  const v = item || {};
  const f = {
    name: h('input', { name: 'name', required: true, value: v.name }),
    cas: h('input', { name: 'cas', value: v.cas, inputmode: 'numeric', placeholder: '67-63-0' }),
    formula: h('input', { name: 'formula', value: v.formula }),
    synonyms: h('input', { name: 'synonyms', value: (v.synonyms || []).join(', ') }),
    quantity: h('input', { name: 'quantity', type: 'number', step: 'any', min: '0', value: v.quantity ?? '' }),
    unit: h('select', { name: 'unit' }, UNITS.map(u => h('option', { value: u, selected: (v.unit || 'g') === u }, u))),
    purity: h('input', { name: 'purity', value: v.purity }),
    ghs: h('input', { name: 'ghs', value: (v.ghs || []).join(', ') }),
    sds_url: h('input', { name: 'sds_url', type: 'url', value: v.sds_url }),
    notes: h('textarea', { name: 'notes', rows: 2 }, v.notes || ''),
  };
  const casHint = h('small', { class: 'hint' });
  const checkCas = () => {
    const c = f.cas.value.trim();
    casHint.textContent = !c ? '' : isValidCas(c) ? `✓ ${t('casValid')}` : `⚠ ${t('casInvalid')}`;
    casHint.className = `hint ${c && !isValidCas(c) ? 'warn' : 'ok'}`;
  };
  f.cas.addEventListener('input', checkCas); checkCas();
  const status = h('p', { class: 'status', id: 'form-status', 'aria-live': 'polite' });
  const loc = locationPicker(v.shelf_id || params.get('shelf') || new URLSearchParams(location.hash.split('?')[1]).get('shelf'));
  let who = v.added_by || me();
  const whoSel = memberSelect({ id: 'added-by', value: who, onchange: n => { who = n; } });
  let photoBlob = null;
  const preview = h('img', { class: 'photo preview', alt: '', hidden: true });

  const fillFrom = (src, { overwrite } = {}) => {
    for (const k of ['name', 'cas', 'formula', 'purity', 'sds_url']) {
      if (src[k] && (overwrite || !f[k].value)) f[k].value = src[k];
    }
    if (src.quantity != null && (overwrite || !f.quantity.value)) f.quantity.value = src.quantity;
    if (src.unit && UNITS.includes(src.unit) && (overwrite || !f.quantity.value || src.quantity != null)) f.unit.value = src.unit;
    if (src.synonyms?.length && (overwrite || !f.synonyms.value)) f.synonyms.value = src.synonyms.join(', ');
    if (src.ghs?.length && (overwrite || !f.ghs.value)) f.ghs.value = src.ghs.join(', ');
    checkCas();
  };

  const pubchem = async () => {
    status.textContent = t('lookingUp');
    try {
      const r = await lookup({ name: f.name.value, cas: f.cas.value });
      if (!r) { status.textContent = t('pubchemNotFound'); return; }
      // the CAS printed on the label wins unless it fails the checksum
      const typed = f.cas.value.trim();
      const keepCas = typed && isValidCas(typed);
      fillFrom({ ...r, cas: keepCas ? '' : r.cas, name: f.name.value ? '' : r.title });
      if (typed && !keepCas && r.cas) {
        f.cas.value = r.cas; checkCas();
        status.textContent = `⚠ ${t('casCorrected', { from: typed, to: r.cas })}`;
      } else if (keepCas && r.cas && normalizeCas(typed) !== r.cas) {
        status.textContent = `⚠ ${t('casMismatch', r.cas)}`;
      } else status.textContent = `✓ ${t('pubchemFilled', r.title)}`;
    } catch (e) { status.textContent = `${t('pubchemError')} (${e.message})`; }
  };

  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'photo', onchange: async () => {
    const file = photo.files[0]; if (!file) return;
    preview.src = URL.createObjectURL(file); preview.hidden = false;
    photoBlob = MOCK ? await toJpeg(file, 600) : await toJpeg(file);
    status.textContent = t('readingLabel');
    try {
      const r = await extractLabel(file, { mock: MOCK });
      fillFrom(r, { overwrite: true });
      status.textContent = r.name ? `✓ ${t('labelRead')}` : t('labelNotRead');
      if (r.name || r.cas) await pubchem();
    } catch (e) { status.textContent = `${t('labelError')} (${e.message})`; }
  } });

  const form = h('form', { class: 'form', id: 'chem-form', onsubmit: async e => {
    e.preventDefault();
    if (!who) { toast(t('pickWhoAdded'), 'err'); return; }
    const shelf_id = loc.value();
    if (!shelf_id && !item) { toast(t('chooseShelf'), 'err'); return; }
    const split = s => s.split(',').map(x => x.trim()).filter(Boolean);
    const data = {
      type: 'chemical', name: f.name.value.trim(), cas: f.cas.value.trim() ? normalizeCas(f.cas.value) : null,
      formula: f.formula.value.trim() || null, synonyms: split(f.synonyms.value),
      quantity: f.quantity.value === '' ? null : Number(f.quantity.value), unit: f.unit.value,
      purity: f.purity.value.trim() || null, ghs: split(f.ghs.value), sds_url: f.sds_url.value.trim() || null,
      notes: f.notes.value.trim() || null, added_by: who,
    };
    try {
      if (photoBlob) data.photo_url = await db.uploadPhoto(photoBlob);
      let saved;
      if (item) {
        saved = await db.editItem(item.id, data, me() || who);
        if (shelf_id && shelf_id !== item.shelf_id) await db.moveItem(item.id, shelf_id, me() || who);
      } else saved = await db.addItem({ ...data, shelf_id }, who);
      prefs.set('labinv-me', who);
      await refresh(); toast(t('saved'));
      location.hash = `#/item/${saved.id}`;
    } catch (err) { toast(`${t('saveError')}: ${err.message}`, 'err'); }
  } },
    item ? null : h('div', { class: 'photo-box' }, h('label', { class: 'button', for: 'photo' }, `📷 ${t('photoLabel')}`), photo, preview),
    status,
    field('name', f.name),
    h('div', { class: 'row' }, field('cas', f.cas, casHint), field('formula', f.formula)),
    h('button', { type: 'button', class: 'secondary', id: 'pubchem-btn', onclick: pubchem }, `🔎 ${t('lookUpPubchem')}`),
    h('div', { class: 'row' }, field('quantity', f.quantity), field('unit', f.unit), field('purity', f.purity)),
    field('ghs', f.ghs), field('sds', f.sds_url), field('synonyms', f.synonyms), field('notes', f.notes),
    h('div', { class: 'field' }, h('span', {}, t('location')), loc.el),
    h('div', { class: 'field' }, h('span', {}, t('addedBy')), whoSel),
    h('p', { class: 'muted' }, `${t('dateAdded')}: ${fmtDate(v.created_at || new Date().toISOString())}`),
    h('button', { type: 'submit', id: 'save-btn' }, item ? t('saveChanges') : t('save')));
  main().replaceChildren(h('h1', {}, item ? t('editMaterial') : t('addMaterial')), form);
}

function viewSampleForm() {
  const f = {
    name: h('input', { name: 'name', required: true, placeholder: t('sampleNameExample') }),
    sender: h('input', { name: 'sender', placeholder: 'Thomas' }),
    institution: h('input', { name: 'institution' }),
    quantity: h('input', { name: 'quantity', type: 'number', step: 'any', min: '0' }),
    unit: h('select', { name: 'unit' }, UNITS.map(u => h('option', { value: u, selected: u === 'pcs' }, u))),
    notes: h('textarea', { name: 'notes', rows: 2 }),
  };
  const loc = locationPicker(new URLSearchParams(location.hash.split('?')[1]).get('shelf'));
  let who = me();
  const whoSel = memberSelect({ id: 'received-by', value: who, onchange: n => { who = n; } });
  const form = h('form', { class: 'form', id: 'sample-form', onsubmit: async e => {
    e.preventDefault();
    if (!who) return toast(t('pickWhoReceived'), 'err');
    const shelf_id = loc.value();
    if (!shelf_id) return toast(t('chooseShelf'), 'err');
    try {
      const saved = await db.addItem({
        type: 'sample', name: f.name.value.trim(), sender: f.sender.value.trim() || null,
        institution: f.institution.value.trim() || null,
        quantity: f.quantity.value === '' ? null : Number(f.quantity.value), unit: f.unit.value,
        notes: f.notes.value.trim() || null, shelf_id, added_by: who,
      }, who);
      prefs.set('labinv-me', who);
      await refresh(); toast(t('saved'));
      location.hash = `#/item/${saved.id}`;
    } catch (err) { toast(`${t('saveError')}: ${err.message}`, 'err'); }
  } },
    field('sampleDescription', f.name),
    h('div', { class: 'row' }, field('sender', f.sender), field('institution', f.institution)),
    h('div', { class: 'row' }, field('quantity', f.quantity), field('unit', f.unit)),
    field('notes', f.notes),
    h('div', { class: 'field' }, h('span', {}, t('location')), loc.el),
    h('div', { class: 'field' }, h('span', {}, t('receivedBy')), whoSel),
    h('p', { class: 'muted' }, `${t('dateAdded')}: ${fmtDate(new Date().toISOString())}`),
    h('button', { type: 'submit', id: 'save-sample-btn' }, t('save')));
  main().replaceChildren(h('h1', {}, t('addSample')), form);
}

function inlineAdd(placeholder, onAdd, extra) {
  const inp = h('input', { placeholder: t(placeholder), 'aria-label': t(placeholder) });
  const go = async () => { if (!inp.value.trim()) return; await onAdd(inp.value.trim(), extra?.value); await refresh(); viewLocations(); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return h('div', { class: 'inline-add' }, inp, extra || null, h('button', { type: 'button', onclick: go }, t('add')));
}

function renameable(table, obj, label) {
  const span = h('span', { class: 'name' }, label);
  const btn = h('button', { type: 'button', class: 'icon', title: t('rename'), 'aria-label': t('rename'), onclick: () => {
    const inp = h('input', { value: obj.name, 'aria-label': t('rename') });
    const save = async () => { await db.rename(table, obj.id, inp.value); await refresh(); viewLocations(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    wrap.replaceChildren(inp, h('button', { type: 'button', onclick: save }, t('save')));
    inp.focus();
  } }, '✎');
  const wrap = h('span', { class: 'renameable' }, span, btn);
  return wrap;
}

function viewLocations() {
  const { rooms, units, shelves } = state.loc;
  const count = sid => state.items.filter(i => i.shelf_id === sid && i.status !== 'used_up').length;
  main().replaceChildren(
    h('h1', {}, t('locations')),
    h('p', {}, h('a', { class: 'button', href: '#/labels' }, `🖨️ ${t('printLabels')}`)),
    h('ul', { class: 'tree' }, rooms.map(r => h('li', { class: 'room' },
      h('div', { class: 'tree-head' }, '🚪 ', renameable('rooms', r, r.name)),
      h('ul', {}, units.filter(u => u.room_id === r.id).map(u => h('li', { class: 'unit' },
        h('div', { class: 'tree-head' }, `${KIND_ICON[u.kind] || ''} `, renameable('units', u, u.name), h('span', { class: 'muted' }, ` (${t(`kind_${u.kind}`)})`)),
        h('ul', {}, shelves.filter(s => s.unit_id === u.id).map(s => h('li', { class: 'shelf' },
          h('a', { href: `#/shelf/${s.id}` }, s.name), h('span', { class: 'muted' }, ` · ${t('nItems', count(s.id))}`),
          ' ', renameable('shelves', s, ''))),
        h('li', {}, inlineAdd('newShelf', name => db.addShelf(u.id, name)))))),
      h('li', {}, inlineAdd('newUnit', (name, kind) => db.addUnit(r.id, name, kind),
        h('select', { 'aria-label': t('unitKind') }, KINDS.map(k => h('option', { value: k }, `${KIND_ICON[k]} ${t(`kind_${k}`)}`)))))))),
      h('li', {}, inlineAdd('newRoom', name => db.addRoom(name)))));
}

function qrSvg(text) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

export function shelfUrl(id) {
  const base = CONFIG.PUBLIC_URL || (location.origin + location.pathname + (MOCK && !CONFIG.PUBLIC_URL && params.has('mock') ? '?mock=1' : ''));
  return `${base}#/shelf/${id}`;
}

function viewLabels() {
  const { shelves } = state.loc;
  const chosen = new Set(shelves.map(s => s.id));
  const sheet = h('div', { class: 'sheet', id: 'label-sheet' });
  const draw = () => sheet.replaceChildren(...shelves.filter(s => chosen.has(s.id)).map(s => {
    const label = h('div', { class: 'label', 'data-url': shelfUrl(s.id) });
    label.innerHTML = qrSvg(shelfUrl(s.id));
    const [room, unit] = shelfPath(state.loc, s.id).split(' › ');
    label.append(h('div', { class: 'label-text' }, h('strong', {}, s.name), h('div', {}, unit || ''), h('div', { class: 'muted' }, room || ''),
      h('div', { class: 'scan' }, t('scanToSee'))));
    return label;
  }));
  main().replaceChildren(
    h('div', { class: 'no-print' },
      h('h1', {}, t('printLabels')),
      h('p', { class: 'muted' }, t('labelsHelp')),
      h('div', { class: 'label-picks' }, shelves.map(s => h('label', {},
        h('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked ? chosen.add(s.id) : chosen.delete(s.id); draw(); } }),
        ' ', shelfPath(state.loc, s.id)))),
      h('button', { type: 'button', onclick: () => print() }, `🖨️ ${t('print')}`)),
    sheet);
  draw();
}

// ---------- shell ----------
function renderHeader() {
  const nav = [['#/', 'search', '🔍'], ['#/add', 'addMaterial', '📷'], ['#/sample', 'addSample', '✉️'], ['#/locations', 'locations', '🗄️']];
  const route = location.hash.split('?')[0] || '#/';
  mount(document.getElementById('header'),
    h('div', { class: 'top' },
      h('a', { href: '#/', class: 'brand' }, `🧪 ${t('appName')}`),
      h('div', { class: 'top-tools' },
        h('label', { class: 'me' }, h('span', {}, t('iAm')),
          memberSelect({ id: 'me-select', value: me(), onchange: n => { prefs.set('labinv-me', n); renderHeader(); } })),
        h('button', { type: 'button', class: 'secondary', id: 'lang-btn', onclick: () => { setLang(getLang() === 'he' ? 'en' : 'he'); render(); } },
          getLang() === 'he' ? 'English' : 'עברית'),
        h('button', { type: 'button', class: 'secondary', id: 'export-btn', onclick: () => downloadXlsx(exportRows(state.items, state.loc)) },
          `⬇ ${t('exportExcel')}`))),
    h('nav', {}, nav.map(([href, key, icon]) => h('a', { href, class: route === href || (href !== '#/' && route.startsWith(href)) ? 'active' : '' }, `${icon} ${t(key)}`))),
    MOCK ? h('div', { class: 'banner' }, t('demoBanner')) : null);
}

function render() {
  document.documentElement.lang = getLang();
  document.documentElement.dir = getLang() === 'he' ? 'rtl' : 'ltr';
  document.title = t('appName');
  renderHeader();
  const [path] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case 'shelf': return viewShelf(parts[1]);
    case 'item': return viewItem(parts[1]);
    case 'add': return viewChemicalForm();
    case 'edit': return viewChemicalForm({ editId: parts[1] });
    case 'sample': return viewSampleForm();
    case 'locations': return viewLocations();
    case 'labels': return viewLabels();
    default: return viewSearch();
  }
}

window.addEventListener('hashchange', render);
try {
  await refresh();
  render();
} catch (e) {
  main().replaceChildren(h('p', { class: 'empty err' }, `${t('loadError')}: ${e.message}`));
}
window.__ready = true;
