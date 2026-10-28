"""Public access through a free Cloudflare quick tunnel, with a fixed front door on GitHub Pages.

Usage:  pythonw server/tunnel.py [--port 8765]

Starts cloudflared, reads the random https://...trycloudflare.com address it is given, and
publishes it to docs/tunnel.json on GitHub. The page docs/index.html (GitHub Pages) reads that
file and forwards visitors, so the printed QR codes never change. If cloudflared stops, it is
started again and the new address is published.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
TUNNEL_FILE = ROOT / "docs" / "tunnel.json"
CLOUDFLARED = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "LabInventory" / "cloudflared" / "cloudflared.exe"
GIT = shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LOG = ROOT / "backups" / "tunnel.log"  # backups/ is not committed


def log(*parts):
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        print(time.strftime("%Y-%m-%d %H:%M:%S"), *parts, file=f)


def git(*args):
    r = subprocess.run([GIT, "-C", str(ROOT), *args], capture_output=True, text=True, creationflags=NO_WINDOW)
    if r.returncode:
        log("git", *args, "->", r.stderr.strip()[-300:])
    return r.returncode == 0


def publish(url):
    TUNNEL_FILE.write_text(json.dumps({"url": url, "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) + "\n",
                           encoding="utf-8")
    git("add", str(TUNNEL_FILE))
    git("commit", "-m", "Update tunnel address", "--", str(TUNNEL_FILE))
    for _ in range(5):  # network may still be coming up right after logon
        if git("push") or (git("pull", "--rebase", "--autostash") and git("push")):
            log("published", url)
            return
        time.sleep(30)
    log("could not publish", url)


def run_once(port):
    p = subprocess.Popen([str(CLOUDFLARED), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, creationflags=NO_WINDOW)
    published = False
    for line in p.stdout:  # keep reading so cloudflared never blocks on a full pipe
        m = URL_RE.search(line)
        if m and not published:
            published = True
            publish(m.group(0))
    p.wait()
    log("cloudflared exited with", p.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    while True:
        run_once(a.port)
        time.sleep(10)


if __name__ == "__main__":
    main()
