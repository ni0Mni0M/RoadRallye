#!/usr/bin/env python3
"""Serve the web folder on http://localhost:8765 with caching off, so fresh rally data shows on reload.

Also answers /api/transit by asking Transitous (https://transitous.org) for train and bus
connections. Transitous wants a contact in every request's User-Agent; it is read from
config.local.json (copy config.example.json), so it never ends up in the published code.
"""

import datetime
import functools
import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
CONFIG = ROOT / "config.local.json"

TRANSITOUS_PLAN = "https://api.transitous.org/api/v5/plan"
APP_NAME = "RoadRalley/1.0"
CACHE_SECONDS = 3600
# Transitous asks apps above about 720 trip searches a day to talk to them first; stay well below.
DAILY_LIMIT = 300

COORD = re.compile(r"-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?")
ISO_TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)")

_lock = threading.Lock()
_cache = {}  # query string -> (fetched at, response body)
_usage = {"day": None, "count": 0}


def load_contact():
    try:
        contact = json.loads(CONFIG.read_text("utf-8")).get("contact", "").strip()
    except (OSError, ValueError, AttributeError):
        return ""
    return "" if contact.startswith("your email") else contact


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/transit":
            self.transit(urllib.parse.parse_qs(url.query))
        else:
            super().do_GET()

    def send_json(self, status, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def transit(self, query):
        arg = lambda name: (query.get(name) or [""])[0]
        params = {"fromPlace": arg("from"), "toPlace": arg("to"), "time": arg("time")}
        if not (COORD.fullmatch(params["fromPlace"]) and COORD.fullmatch(params["toPlace"])
                and ISO_TIME.fullmatch(params["time"])):
            return self.send_json(400, {"error": "bad-request"})
        contact = load_contact()
        if not contact:
            return self.send_json(503, {"error": "no-contact"})

        key = urllib.parse.urlencode(params)
        with _lock:
            cached = _cache.get(key)
            if cached and time.time() - cached[0] < CACHE_SECONDS:
                return self.send_json(200, cached[1])
            today = datetime.date.today()
            if _usage["day"] != today:
                _usage.update(day=today, count=0)
            if _usage["count"] >= DAILY_LIMIT:
                return self.send_json(429, {"error": "limit"})
            _usage["count"] += 1

        req = urllib.request.Request(
            f"{TRANSITOUS_PLAN}?{urllib.parse.urlencode({**params, 'language': 'en'})}",
            headers={"User-Agent": f"{APP_NAME} ({contact})", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                body = resp.read()
        except urllib.error.HTTPError as e:
            return self.send_json(502, {"error": "upstream", "status": e.code})
        except Exception:
            return self.send_json(502, {"error": "upstream"})

        with _lock:
            _cache[key] = (time.time(), body)
        self.send_json(200, body)


class Server(http.server.ThreadingHTTPServer):
    # On Windows, address reuse lets a second copy silently share the port with an old one.
    allow_reuse_address = os.name != "nt"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(Handler, directory=str(WEB_DIR))
    try:
        server = Server(("127.0.0.1", port), handler)
    except OSError:
        print(f"Port {port} is already in use. Close the other RoadRalley window first.", file=sys.stderr)
        return 1
    with server:
        print(f"Serving {WEB_DIR} on http://localhost:{port} (Ctrl+C to stop)", flush=True)
        if not load_contact():
            print("No contact in config.local.json: live train and bus times are off.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
