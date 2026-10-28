"""Import the initial inventory (built from shelf photos) into the lab server.

CSV columns (header row required; empty cells allowed):
  room, unit, unit_kind, shelf, type, name, cas, formula, quantity, qty_unit,
  purity, sender, institution, added_by, notes

Rooms / units / shelves / members are created when missing (matched by name).

Usage:
  python import_seed.py seed.csv --dry-run          # validate only, no network
  python import_seed.py seed.csv                    # server on this computer
  python import_seed.py seed.csv --url http://<host>:8765/
"""
import argparse
import csv
import json
import secrets
import sys
import urllib.request
from datetime import datetime, timezone

ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
KINDS = {"cabinet", "fridge", "freezer", "flammables", "acid", "glovebox", "other"}


def new_id():
    return "".join(secrets.choice(ALPHABET) for _ in range(8))


def cas_ok(cas):
    parts = cas.split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts) or len(parts[1]) != 2 or len(parts[2]) != 1:
        return False
    body = (parts[0] + parts[1])[::-1]
    return sum(int(d) * (i + 1) for i, d in enumerate(body)) % 10 == int(parts[2])


class Api:
    """Talks to server/server.py (same API the app uses)."""
    def __init__(self, url):
        self.base = url.rstrip("/") + "/api/"

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or "[]")

    def all(self, table):
        return self._req("GET", table)

    def insert(self, table, rows):
        return [self._req("POST", table, row) for row in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--url", default="http://127.0.0.1:8765/")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = [{k.strip(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f)]

    problems = []
    for n, r in enumerate(rows, start=2):
        if not r.get("name"):
            problems.append(f"line {n}: missing name")
        if not (r.get("room") and r.get("unit") and r.get("shelf")):
            problems.append(f"line {n}: missing room/unit/shelf")
        if r.get("cas") and not cas_ok(r["cas"]):
            problems.append(f"line {n}: CAS {r['cas']} fails checksum ({r.get('name')})")
        if r.get("unit_kind") and r["unit_kind"] not in KINDS:
            problems.append(f"line {n}: unknown unit_kind {r['unit_kind']}")
    print(f"{len(rows)} rows, {len(problems)} problems")
    for p in problems:
        print("  " + p)
    if a.dry_run:
        return 1 if problems else 0
    api = Api(a.url)
    now = datetime.now(timezone.utc).isoformat()
    rooms = {x["name"]: x["id"] for x in api.all("rooms")}
    units = {(x["room_id"], x["name"]): x["id"] for x in api.all("units")}
    shelves = {(x["unit_id"], x["name"]): x["id"] for x in api.all("shelves")}
    members = {x["name"] for x in api.all("members")}

    items, events = [], []
    for r in rows:
        if not r.get("name"):
            continue
        if r["room"] not in rooms:
            rooms[r["room"]] = api.insert("rooms", [{"id": new_id(), "name": r["room"], "created_at": now}])[0]["id"]
        rid = rooms[r["room"]]
        if (rid, r["unit"]) not in units:
            units[(rid, r["unit"])] = api.insert("units", [{"id": new_id(), "room_id": rid, "name": r["unit"],
                                                            "kind": r.get("unit_kind") or "cabinet", "created_at": now}])[0]["id"]
        uid = units[(rid, r["unit"])]
        if (uid, r["shelf"]) not in shelves:
            shelves[(uid, r["shelf"])] = api.insert("shelves", [{"id": new_id(), "unit_id": uid, "name": r["shelf"],
                                                                 "created_at": now}])[0]["id"]
        who = r.get("added_by") or None
        if who and who not in members:
            api.insert("members", [{"id": new_id(), "name": who, "created_at": now}])
            members.add(who)
        iid = new_id()
        items.append({
            "id": iid, "type": r.get("type") or "chemical", "name": r["name"], "cas": r.get("cas") or None,
            "formula": r.get("formula") or None, "quantity": float(r["quantity"]) if r.get("quantity") else None,
            "unit": r.get("qty_unit") or None, "purity": r.get("purity") or None, "sender": r.get("sender") or None,
            "institution": r.get("institution") or None, "shelf_id": shelves[(uid, r["shelf"])], "added_by": who,
            "notes": r.get("notes") or None, "status": "active", "created_at": now, "updated_at": now,
        })
        events.append({"id": new_id(), "item_id": iid, "action": "add", "by": who, "at": now,
                       "details": {"source": "seed import"}})
    api.insert("items", items)
    api.insert("events", events)
    print(f"imported {len(items)} items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
