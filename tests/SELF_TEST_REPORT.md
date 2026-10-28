# Self-test report: 2026-10-28

The tests were run against the demo (mock) backend in a browser, using a local static server. Re-run the whole list after any change.

## Level 1: unit tests (`tests/index.html`)
**19 / 19 pass.** They cover:
- **CAS:** checksum, single-digit misreads, normalisation
- **PubChem:** parsing of recorded responses (formula, CAS, synonyms, GHS pictograms and H-codes, taken only from the summary record)
- **Search:** isoprop / IPA / 67-63-0 / 67630 / C3H8O / typos / sender / type filter / used-up hidden
- **Translations:** EN↔HE key parity, and every `t()` key in app.js exists
- **History and data:** add/move/used-up/restore are logged with who and when, nothing can be deleted, members are de-duplicated, sample date is set automatically
- **Export:** Excel row mapping

Node is not installed on this machine, so the tests run in the browser instead.

## Level 2: end-to-end in the browser (demo backend)
| # | Check | Result |
|---|---|---|
| 1 | Create room → Flammables / Fridge / Upper right cabinet → 4 shelves in the UI | ✅ |
| 2 | Print page: all 4 QR codes decoded with jsQR, and each matches its shelf URL; A4 3×8 grid | ✅ |
| 3 | Opening the decoded QR URL shows the shelf view with the right path and quick-add buttons | ✅ |
| 4 | Photo upload (`isopropanol.png`, stubbed extractor) → PubChem fill: all 6 fields match `expected.json`, plus GHS and SDS link; saved with history "Added — Nir" | ✅ |
| 4b | Manually typed CAS with a wrong digit (64-17-6) is flagged, and PubChem replaces it with 64-17-5 | ✅ after fix (bug 1) |
| 5 | Sample "5 nm gold nanoparticles", sender Thomas, received by Nir, upper right cabinet → today's date, Sample tag, correct shelf | ✅ |
| 6 | Search in the UI: isoprop, IPA, 67-63-0, C3H8O, "potasium" (typo), Thomas, gold, and the type filter | ✅ |
| 7 | Mark KOH used up from the shelf view (disappears, can be restored, history shown); move 2-Propanol to the fridge (history shows from → to); no delete controls anywhere | ✅ |
| 8 | Add member "Dana" from the header; the choice is remembered after a reload | ✅ |
| 9 | Excel export opened with openpyxl: 16 columns, 4 rows, readable locations, "used up" status | ✅ |
| 10 | Hebrew: `dir=rtl` on all 8 views, no untranslated UI strings, English data displays correctly | ✅ after fix (bug 2) |
| 11 | Phone width 375 px: no horizontal page scroll on any of the 7 views | ✅ |
| – | Sweep of 13 views × 2 languages for "null"/"undefined" text; no console errors | ✅ after fix (bug 3) |
| – | `import_seed.py --dry-run` catches a bad CAS (exit 1) and passes a clean file (exit 0) | ✅ |

### Bugs found and fixed during the self-test
1. When the CAS on the form failed its checksum, the PubChem lookup did not replace it. It now replaces the bad number and says so.
2. In Hebrew mode, English data was reordered ("2-Propanol" was shown as "Propanol-2"). Each data field now sets its own text direction.
3. A stray "null" appeared under the search filters. The same mistake would also have shown "null" in the header in production mode. Both are fixed.

Also fixed: a duplicate file-picker button on the add form, the checkbox size, and a stale-cache problem in local testing (the dev server now sends no-cache headers).

## Level 3: real server on this computer (2026-10-28)
Supabase is blocked on the university network, so the backend is now `server/server.py` (SQLite on this computer).

| # | Check | Result |
|---|---|---|
| 1 | API: insert, update, list; duplicate or malformed ids rejected; unknown rows/tables give 404 | ✅ |
| 2 | Nothing can be deleted: `DELETE` gives 405 and the row stays; the history log (events) cannot be edited (403) | ✅ |
| 3 | Only the app files are served: README, server code, `../` and `%2e%2e` tricks, backslash paths and photo-folder escapes all give 404 | ✅ after fix (bug 4) |
| 4 | Real AI label reading (Claude) on `isopropanol.png`: name, CAS, formula, size, purity all correct (~9 s) | ✅ |
| 5 | In the app: photo of `niso4.png` → AI + live PubChem fill all 6 fields correctly, plus GHS; saved with the photo, which displays on the item page | ✅ |
| 6 | Without a name chosen, saving is refused with "Choose who added it" | ✅ |
| 7 | Add/move/used-up through the real server, with the history logged by name | ✅ |
| 8 | Data survives a server restart | ✅ |
| 9 | Daily backup writes one self-contained `.db` file | ✅ after fix (bug 5) |
| 10 | `import_seed.py` imports into the server, creating rooms, units and shelves | ✅ |
| 11 | Unit tests 19/19 served by the real server | ✅ |

Bugs fixed:

4. A crafted address (`js/../server/...`) could read files outside the app folders, including the backups. Paths are now normalised and checked before serving.
5. Database connections were not closed, which left `-wal`/`-shm` side files next to the backups. Each connection is now closed, and backups are single files.

Not yet verified: access from phones over the network (needs the Windows firewall "Allow" and a test on campus Wi-Fi), and scanning a printed QR label.
