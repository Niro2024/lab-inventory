// Data layer. Both backends expose the same tiny table API
// (all / insert / update / upload); all inventory logic lives here on top of it,
// so the mock used in tests runs exactly the same code as production.
// There is intentionally no delete operation anywhere.

export const newId = () => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r, x => a[x % a.length]).join('');
};

export function mockBackend(storage = globalThis.localStorage, key = 'labinv-mock') {
  const load = () => {
    try { return JSON.parse(storage.getItem(key)) || {}; } catch { return {}; }
  };
  const save = d => { try { storage.setItem(key, JSON.stringify(d)); } catch { /* memory only */ } };
  let data = load();
  const table = t => (data[t] ||= []);
  return {
    kind: 'mock',
    async all(t) { return structuredClone(table(t)); },
    async insert(t, row) { table(t).push(structuredClone(row)); save(data); return row; },
    async update(t, id, patch) {
      const r = table(t).find(x => x.id === id);
      if (!r) throw new Error(`${t}/${id} not found`);
      Object.assign(r, structuredClone(patch)); save(data); return structuredClone(r);
    },
    async upload(blob) {
      return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    },
    async removeLocation(t, id, parts) {
      for (const [tt, ids] of [['shelves', parts.shelves], ['units', parts.units], [t, [id]]]) {
        data[tt] = table(tt).filter(x => !ids.includes(x.id));
      }
      save(data);
    },
    reset() { data = {}; save(data); },
  };
}

// The lab server (server/server.py). `base` is where the app is served from.
export function httpBackend(base = '', fetchFn = globalThis.fetch.bind(globalThis)) {
  const call = async (method, path, body, type = 'application/json') => {
    const r = await fetchFn(`${base}api/${path}`, {
      method, headers: body ? { 'Content-Type': type } : {},
      body: body && type === 'application/json' ? JSON.stringify(body) : body,
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${method} ${path}: ${r.status}`);
    return out;
  };
  return {
    kind: 'server',
    all: t => call('GET', t),
    insert: (t, row) => call('POST', t, row),
    update: (t, id, patch) => call('PATCH', `${t}/${encodeURIComponent(id)}`, patch),
    async upload(blob) { return (await call('POST', 'upload', blob, 'image/jpeg')).url; },
    // the server checks emptiness itself and removes what is inside the location
    async removeLocation(t, id) { await call('DELETE', `${t}/${encodeURIComponent(id)}`); },
  };
}

const ITEM_FIELDS = ['type', 'name', 'cas', 'formula', 'synonyms', 'quantity', 'unit', 'purity', 'ghs',
  'sds_url', 'sender', 'institution', 'shelf_id', 'added_by', 'photo_url', 'notes'];

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

export function createDb(backend) {
  const now = () => new Date().toISOString();
  const log = (item_id, action, by, details = {}) =>
    backend.insert('events', { id: newId(), item_id, action, by: by || null, at: now(), details });
  const requireName = s => { s = String(s || '').trim(); if (!s) throw new Error('name required'); return s; };

  return {
    backend,

    async locations() {
      const [rooms, units, shelves] = await Promise.all(['rooms', 'units', 'shelves'].map(t => backend.all(t)));
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
      return { rooms: rooms.sort(byName), units: units.sort(byName), shelves: shelves.sort(byName) };
    },
    addRoom: name => backend.insert('rooms', { id: newId(), name: requireName(name), created_at: now() }),
    addUnit: (room_id, name, kind = 'cabinet') =>
      backend.insert('units', { id: newId(), room_id, name: requireName(name), kind, created_at: now() }),
    addShelf: (unit_id, name) => backend.insert('shelves', { id: newId(), unit_id, name: requireName(name), created_at: now() }),
    rename: (table, id, name) => backend.update(table, id, { name: requireName(name) }),
    // A room / unit / shelf added by mistake can be removed while no item (even a used-up one) was ever in it.
    async locationParts(table, id) {
      const [loc, items] = await Promise.all([this.locations(), backend.all('items')]);
      const units = loc.units.filter(u => (table === 'rooms' && u.room_id === id) || (table === 'units' && u.id === id));
      const unitIds = new Set(units.map(u => u.id));
      const shelfIds = new Set(loc.shelves.filter(s => unitIds.has(s.unit_id) || (table === 'shelves' && s.id === id)).map(s => s.id));
      return { units: [...unitIds], shelves: [...shelfIds], empty: !items.some(i => shelfIds.has(i.shelf_id)) };
    },
    async removeLocation(table, id) {
      const p = await this.locationParts(table, id);
      if (!p.empty) throw new Error('not empty');
      await backend.removeLocation(table, id, p);
    },

    async members() { return (await backend.all('members')).sort((a, b) => a.name.localeCompare(b.name)); },
    async addMember(name) {
      name = requireName(name);
      const existing = (await backend.all('members')).find(m => m.name.toLowerCase() === name.toLowerCase());
      return existing || backend.insert('members', { id: newId(), name, created_at: now() });
    },

    items: () => backend.all('items'),
    async item(id) { return (await backend.all('items')).find(i => i.id === id) || null; },
    async history(item_id) {
      return (await backend.all('events')).filter(e => e.item_id === item_id).sort((a, b) => a.at.localeCompare(b.at));
    },

    async addItem(fields, by) {
      const t = now();
      const row = { synonyms: [], ghs: [], type: 'chemical', ...pick(fields, ITEM_FIELDS), id: newId(),
        name: requireName(fields.name), added_by: fields.added_by || by || null,
        status: 'active', created_at: t, updated_at: t };
      await backend.insert('items', row);
      await log(row.id, 'add', row.added_by, { shelf_id: row.shelf_id || null });
      return row;
    },
    async editItem(id, fields, by) {
      const patch = { ...pick(fields, ITEM_FIELDS.filter(k => k !== 'shelf_id')), updated_at: now() };
      if ('name' in patch) patch.name = requireName(patch.name);
      const r = await backend.update('items', id, patch);
      await log(id, 'edit', by, { fields: Object.keys(patch).filter(k => k !== 'updated_at') });
      return r;
    },
    async moveItem(id, shelf_id, by) {
      const before = await this.item(id);
      const r = await backend.update('items', id, { shelf_id, updated_at: now() });
      await log(id, 'move', by, { from: before?.shelf_id || null, to: shelf_id });
      return r;
    },
    async markUsedUp(id, by) {
      const r = await backend.update('items', id, { status: 'used_up', updated_at: now() });
      await log(id, 'used_up', by);
      return r;
    },
    async restore(id, by) {
      const r = await backend.update('items', id, { status: 'active', updated_at: now() });
      await log(id, 'restore', by);
      return r;
    },
    uploadPhoto: blob => backend.upload(blob),
  };
}

// Human-readable "Room › Unit › Shelf" for a shelf id.
export function shelfPath(loc, shelf_id) {
  const s = loc.shelves.find(x => x.id === shelf_id);
  if (!s) return '';
  const u = loc.units.find(x => x.id === s.unit_id);
  const r = u && loc.rooms.find(x => x.id === u.room_id);
  return [r?.name, u?.name, s.name].filter(Boolean).join(' › ');
}
