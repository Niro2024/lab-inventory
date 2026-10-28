// Excel export of the whole inventory (SheetJS is loaded globally as XLSX).
import { shelfPath } from './db.js';

export const EXPORT_COLUMNS = ['Name', 'Type', 'CAS', 'Formula', 'Quantity', 'Unit', 'Purity', 'GHS',
  'Location', 'Added by', 'Date added', 'Status', 'Sender', 'Institution', 'Notes', 'SDS'];

export function exportRows(items, loc) {
  return [...items]
    .sort((a, b) => shelfPath(loc, a.shelf_id).localeCompare(shelfPath(loc, b.shelf_id)) || a.name.localeCompare(b.name))
    .map(i => ({
      Name: i.name, Type: i.type, CAS: i.cas || '', Formula: i.formula || '',
      Quantity: i.quantity ?? '', Unit: i.unit || '', Purity: i.purity || '',
      GHS: (i.ghs || []).join(', '), Location: shelfPath(loc, i.shelf_id),
      'Added by': i.added_by || '', 'Date added': (i.created_at || '').slice(0, 10),
      Status: i.status === 'used_up' ? 'used up' : 'active',
      Sender: i.sender || '', Institution: i.institution || '', Notes: i.notes || '', SDS: i.sds_url || '',
    }));
}

export function downloadXlsx(rows, filename = `lab-inventory-${new Date().toISOString().slice(0, 10)}.xlsx`) {
  const ws = globalThis.XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS });
  ws['!cols'] = EXPORT_COLUMNS.map(c => ({ wch: c === 'Name' || c === 'Location' ? 34 : 14 }));
  const wb = globalThis.XLSX.utils.book_new();
  globalThis.XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  globalThis.XLSX.writeFile(wb, filename);
}
