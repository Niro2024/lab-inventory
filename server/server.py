"""Lab Inventory server: serves the app and stores the inventory on this computer.

Usage:  python server/server.py [--port 8765] [--host 0.0.0.0] [--data DIR]

- Data (SQLite database + label photos) lives in --data, default %LOCALAPPDATA%\\LabInventory,
  outside the code folder and outside OneDrive (sync tools and open databases don't mix).
- A copy of the database and new photos is made to --backup once a day (default: ./backups).
- The AI key for label reading is read from ANTHROPIC_API_KEY or <data>/anthropic_key.txt.
  It is never sent to the browser.

API (the app's db.js `httpBackend` speaks this):
  GET   /api/<table>            all rows
  POST  /api/<table>            insert one row (JSON with a string "id")
  PATCH /api/<table>/<id>       merge fields into a row (not allowed for events)
  POST  /api/upload             JPEG body -> {"url": "photos/..."}
  POST  /api/extract-label      {"image": base64, "media_type": ...} -> label fields
There is deliberately no delete.
"""
import argparse
import contextlib
import datetime as dt
import http.server
import json
import os
import pathlib
import posixpath
import re
import secrets
import shutil
import sqlite3
import threading
import time
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLES = {"rooms", "units", "shelves", "members", "items", "events"}
APPEND_ONLY = {"events"}
MAX_BODY = 12_000_000
STATIC_DIRS = ("js/", "css/", "tests/")  # anything else under ROOT is not served

write_lock = threading.Lock()


# ---------- storage ----------
class Store:
    def __init__(self, data_dir: pathlib.Path):
        self.dir = data_dir
        self.photos = data_dir / "photos"
        self.photos.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "inventory.db"
        with self.connect() as c:
            c.execute("pragma journal_mode=wal")
            c.execute("""create table if not exists rows (
                tbl text not null, id text not null, data text not null,
                primary key (tbl, id))""")

    @contextlib.contextmanager
    def connect(self):
        """One short-lived connection: commit on success, always close."""
        c = sqlite3.connect(self.path, timeout=10)
        try:
            with c:
                yield c
        finally:
            c.close()

    def all(self, tbl):
        with self.connect() as c:
            return [json.loads(d) for (d,) in c.execute(
                "select data from rows where tbl=? order by rowid", (tbl,))]

    def insert(self, tbl, row):
        with write_lock, self.connect() as c:
            try:
                c.execute("insert into rows (tbl, id, data) values (?,?,?)",
                          (tbl, row["id"], json.dumps(row, ensure_ascii=False)))
            except sqlite3.IntegrityError:
                raise ValueError(f"{tbl}/{row['id']} already exists")
        return row

    def update(self, tbl, id_, patch):
        with write_lock, self.connect() as c:
            cur = c.execute("select data from rows where tbl=? and id=?", (tbl, id_)).fetchone()
            if not cur:
                raise KeyError(f"{tbl}/{id_} not found")
            row = {**json.loads(cur[0]), **patch, "id": id_}
            c.execute("update rows set data=? where tbl=? and id=?",
                      (json.dumps(row, ensure_ascii=False), tbl, id_))
        return row

    def save_photo(self, jpeg: bytes):
        day = dt.date.today().isoformat()
        folder = self.photos / day
        folder.mkdir(exist_ok=True)
        name = f"{secrets.token_hex(6)}.jpg"
        (folder / name).write_bytes(jpeg)
        return f"photos/{day}/{name}"

    def backup(self, dest: pathlib.Path, keep_days=30):
        """Consistent copy of the database plus any new photos."""
        dest.mkdir(parents=True, exist_ok=True)
        target = dest / f"inventory-{dt.date.today().isoformat()}.db"
        with self.connect() as src, contextlib.closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            dst.execute("pragma journal_mode=delete")  # single self-contained file
        for p in self.photos.rglob("*.jpg"):
            out = dest / "photos" / p.relative_to(self.photos)
            if not out.exists():
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, out)
        dbs = sorted(dest.glob("inventory-*.db"))
        for old in dbs[:-keep_days]:
            old.unlink()
        return target


# ---------- label reading ----------
PROMPT = """This is a photo of a chemical bottle label from a research lab.
Read only what is printed on the label. Do not guess a CAS number that is not visible -
leave it empty instead. Copy the CAS digits exactly."""

_ai = {}


def ai_client(data_dir):
    if "client" not in _ai:
        key = os.environ.get("ANTHROPIC_API_KEY")
        key_file = data_dir / "anthropic_key.txt"
        if not key and key_file.exists():
            key = key_file.read_text(encoding="utf-8").strip()
        if not key:
            raise RuntimeError("No AI key: put it in " + str(key_file))
        import anthropic
        _ai["client"] = anthropic.Anthropic(api_key=key)
    return _ai["client"]


def extract_label(data_dir, image_b64, media_type):
    from typing import Literal
    from pydantic import BaseModel, Field

    class Label(BaseModel):
        name: str = Field(description="Chemical or product name as printed, in English")
        cas: str = Field(description="CAS number like 67-63-0, or empty string if not printed")
        formula: str = Field(description="Molecular formula if printed, else empty")
        quantity: float | None = Field(description="Bottle size number, e.g. 500")
        unit: Literal["g", "mg", "kg", "mL", "L", "µL", "mmol", "pcs", ""]
        purity: str = Field(description="Purity or grade, e.g. '≥99.5%, ACS reagent', else empty")
        supplier: str = Field(description="Manufacturer, else empty")

    response = ai_client(data_dir).messages.parse(
        model=os.environ.get("AI_MODEL", "claude-opus-5-5"),
        max_tokens=16000,
        output_config={"effort": "low"},
        output_format=Label,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
            {"type": "text", "text": PROMPT},
        ]}],
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return {}
    return response.parsed_output.model_dump()


hits: dict[str, list[float]] = {}


def rate_limited(ip, per_hour=120):
    now = time.time()
    recent = [t for t in hits.get(ip, []) if now - t < 3600] + [now]
    hits[ip] = recent
    return len(recent) > per_hour


# ---------- HTTP ----------
class Handler(http.server.SimpleHTTPRequestHandler):
    store: Store = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if self.path == "/api/health":  # the GitHub Pages front door checks this before forwarding
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_request(self, code="-", size="-"):  # keep the console quiet except for errors
        if str(code).startswith(("4", "5")):
            super().log_request(code, size)

    def send_json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("request too large")
        return self.rfile.read(n)

    def route(self):
        parts = [p for p in urlsplit(self.path).path.split("/") if p]
        return parts[1:] if parts[:1] == ["api"] else None

    def do_GET(self):
        path = posixpath.normpath(unquote(urlsplit(self.path).path).replace("\\", "/"))
        if path in (".", "/"):
            path = "/"
        if not path.startswith("/") or "/.." in path:
            return self.send_error(404)
        self.path = path  # serve exactly the checked path
        api = self.route()
        if api is not None:
            if api == ["health"]:
                return self.send_json({"ok": True})
            if len(api) == 1 and api[0] in TABLES:
                return self.send_json(self.store.all(api[0]))
            return self.send_json({"error": "not found"}, 404)
        if path.startswith("/photos/"):
            f = (self.store.photos / path[len("/photos/"):]).resolve()
            if self.store.photos.resolve() in f.parents and f.is_file():
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            return self.send_error(404)
        rel = path.lstrip("/")
        if rel in ("", "index.html") or rel.startswith(STATIC_DIRS):
            return super().do_GET()
        self.send_error(404)

    def do_POST(self):
        api = self.route()
        try:
            if api == ["upload"]:
                jpeg = self.body()
                if not jpeg.startswith(b"\xff\xd8"):
                    return self.send_json({"error": "JPEG expected"}, 400)
                return self.send_json({"url": self.store.save_photo(jpeg)})
            if api == ["extract-label"]:
                if rate_limited(self.client_address[0]):
                    return self.send_json({"error": "Too many requests, try again later"}, 429)
                req = json.loads(self.body())
                image = req.get("image") or ""
                if not image:
                    return self.send_json({"error": "Missing image"}, 400)
                media = "image/png" if req.get("media_type") == "image/png" else "image/jpeg"
                try:
                    return self.send_json(extract_label(self.store.dir, image, media))
                except Exception as e:  # AI problems must not break manual entry
                    print("extract-label:", e)
                    # 200, not 5xx: a tunnel in front replaces 5xx bodies with its own error page
                    return self.send_json({"error": str(e)})
            if api and len(api) == 1 and api[0] in TABLES:
                row = json.loads(self.body())
                if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not re.fullmatch(r"[\w-]{1,40}", row["id"]):
                    return self.send_json({"error": "row needs a string id"}, 400)
                return self.send_json(self.store.insert(api[0], row))
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"error": "not found"}, 404)

    def do_PATCH(self):
        api = self.route()
        if not (api and len(api) == 2 and api[0] in TABLES):
            return self.send_json({"error": "not found"}, 404)
        if api[0] in APPEND_ONLY:
            return self.send_json({"error": f"{api[0]} cannot be changed"}, 403)
        try:
            patch = json.loads(self.body())
            if not isinstance(patch, dict):
                raise ValueError("JSON object expected")
            return self.send_json(self.store.update(api[0], api[1], patch))
        except KeyError as e:
            return self.send_json({"error": str(e)}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)

    def do_DELETE(self):
        self.send_json({"error": "nothing can be deleted"}, 405)

    do_PUT = do_DELETE


def daily_backups(store, dest):
    while True:
        try:
            print("backup ->", store.backup(dest))
        except Exception as e:
            print("backup failed:", e)
        time.sleep(24 * 3600)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--data", default=os.path.join(os.environ.get("LOCALAPPDATA", str(ROOT)), "LabInventory"))
    ap.add_argument("--backup", default=str(ROOT / "backups"))
    ap.add_argument("--no-backup", action="store_true")
    a = ap.parse_args()

    Handler.store = Store(pathlib.Path(a.data))
    if not a.no_backup:
        threading.Thread(target=daily_backups, args=(Handler.store, pathlib.Path(a.backup)), daemon=True).start()
    handler = lambda *args, **kw: Handler(*args, directory=str(ROOT), **kw)
    print(f"Lab Inventory on http://{a.host}:{a.port}/  (data: {a.data})")
    http.server.ThreadingHTTPServer((a.host, a.port), handler).serve_forever()


if __name__ == "__main__":
    main()
