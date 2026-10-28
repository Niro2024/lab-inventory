# Lab Inventory

A web app for tracking the lab's chemicals and external samples. Each shelf gets a QR code: scan it to see what is on the shelf and to add or remove items. You can search by name, CAS number, synonym (e.g. "IPA") or formula, and add materials by photographing the label. The UI is in English and Hebrew.

- **Server:** one Python program ([server/server.py](server/server.py)) on a lab computer that stays on. It serves the app, stores the inventory in a SQLite database, keeps the label photos, and reads labels with AI. It needs no outside database service.
- **App:** plain HTML + JS with no build step ([index.html](index.html), [js/](js)). Phones open it from the server's address.
- **Demo mode:** opened anywhere else, or with `?mock=1`, the app runs entirely in the browser. This is useful for trying it out.

## Where things live

| What | Where |
|---|---|
| Code | this folder (and the GitHub repository) |
| Database + label photos | `%LOCALAPPDATA%\LabInventory\` (`inventory.db`, `photos\`). This is deliberately outside OneDrive, because sync tools corrupt open databases |
| AI key | `%LOCALAPPDATA%\LabInventory\anthropic_key.txt` (or the `ANTHROPIC_API_KEY` environment variable). It is never sent to browsers and never committed |
| Daily backups | `backups\` in this folder: one database copy per day, the last 30 kept, plus all photos. This folder is on OneDrive, so the backups are off the machine too. Not committed |

## Running

```bash
python server/server.py
```

The server listens on port 8765 on all network interfaces. Phones on the same network open `http://<this computer's IP>:8765/`. The first time it runs, Windows asks whether Python may accept network connections; answer **Allow**.

Options: `--port`, `--host 127.0.0.1` (this computer only), `--data DIR`, `--backup DIR`, `--no-backup`. `AI_MODEL` overrides the label-reading model (default `claude-opus-5-5`).

To start it automatically at logon, the setup creates a Windows Task Scheduler task named **Lab Inventory**. It runs `pythonw.exe server\server.py`, which has no console window.

## API

The app and `scripts/import_seed.py` use the same small API:

- `GET /api/<table>`: list rows. Tables are rooms, units, shelves, members, items and events.
- `POST /api/<table>`: insert a row.
- `PATCH /api/<table>/<id>`: update a row. The events history cannot be changed.
- `POST /api/upload`: upload a JPEG label photo.
- `POST /api/extract-label`: read a label with AI. Limited to 120 per hour per device.

There is no delete. Used-up items are marked instead and can be restored. Every add, edit, move and used-up action is recorded with who did it and when.

## Importing the first inventory (from shelf photos)

Fill a CSV like [scripts/seed_example.csv](scripts/seed_example.csv). Missing rooms, units, shelves and members are created automatically. Validate the file first; the check catches CAS typos by their checksum. Then import it into the running server:

```bash
python scripts/import_seed.py seed.csv --dry-run
```
```bash
python scripts/import_seed.py seed.csv
```

## Printing labels

Go to *Locations*, create rooms, cabinets/fridges and shelves, then open *Print QR labels*. The page fits an A4 sheet of 3 × 8 labels at 70 × 37 mm. Print at 100% scale. The QR codes point to the address the app was opened from, unless `PUBLIC_URL` in [js/config.js](js/config.js) says otherwise. Print from the address phones will use, not from `localhost`.

## Access model

No login is needed. Anyone who can reach the server can view, add and edit, which was a deliberate choice. Nothing can be deleted, and all changes are logged.

## Tests

- Unit tests: open `/tests/index.html` on the running server (19 tests: CAS checksum, search, PubChem parsing, translations, history logic, Excel export).
- End-to-end checklist and the last results: [tests/SELF_TEST_REPORT.md](tests/SELF_TEST_REPORT.md).
