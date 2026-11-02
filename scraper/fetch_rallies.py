#!/usr/bin/env python3
"""Fetch every roadsurfer rally (one-way relocation) offer and save it for the web page.

Uses the same JSON endpoints as booking.roadsurfer.com/rally. Each endpoint needs an
X-Requested-Alias header naming it, otherwise the server answers with a 404 page.

    stations                    rally.startStations   all stations (with coordinates)
    stations/<start>            rally.fetchRoutes     destinations reachable from <start>
    timeframes/<start>-<end>    rally.timeframes      bookable date windows for one route

Only the Python standard library is used, so no pip install is needed.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://booking.roadsurfer.com/api/{locale}/rally"
USER_AGENT = "rally-roundtrip-finder/1.0 (personal use; few requests per day)"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "data"

# Abort without touching the existing data if more than this share of routes fail.
MAX_FAILURE_RATE = 0.2


class Client:
    def __init__(self, locale, delay):
        self.base = API.format(locale=locale)
        self.delay = delay
        self.requests = 0

    def get(self, path, alias, retries=3):
        """GET a JSON endpoint. Returns None on 404 (route with no dates)."""
        req = urllib.request.Request(
            self.base + path,
            headers={
                "X-Requested-Alias": alias,
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(retries):
            if self.requests:
                time.sleep(self.delay)
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if attempt == retries - 1:
                    raise
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                if attempt == retries - 1:
                    raise
            time.sleep(2 ** (attempt + 1))
        return None


def slim_station(s):
    coord = s.get("coordinate") or {}
    city = s.get("city") or {}
    return {
        "id": s["id"],
        "name": s["name"],
        "city": city.get("name"),
        "country": city.get("country"),
        "lat": coord.get("latitude"),
        "lon": coord.get("longitude"),
    }


def fetch_all(client, log):
    stations = client.get("/stations", "rally.startStations")
    if not stations:
        raise RuntimeError("Station list came back empty")

    starts = [s for s in stations if s.get("one_way") and s.get("public") and s.get("enabled")]
    log(f"{len(stations)} stations, {len(starts)} offer one-way rallies")

    routes = []
    for i, s in enumerate(starts, 1):
        detail = client.get(f"/stations/{s['id']}", "rally.fetchRoutes") or {}
        for end in detail.get("returns") or []:
            routes.append((s["id"], end))
        log(f"  [{i}/{len(starts)}] {s['name']}: {len(detail.get('returns') or [])} destinations")

    log(f"{len(routes)} routes, fetching dates...")
    rallies, failures = [], 0
    for i, (start, end) in enumerate(routes, 1):
        try:
            frames = client.get(f"/timeframes/{start}-{end}", "rally.timeframes") or []
        except Exception as e:  # keep going; one bad route shouldn't sink the run
            failures += 1
            log(f"  ! {start}-{end}: {e}")
            continue
        for f in frames:
            rallies.append({
                "from": start,
                "to": end,
                "pickup": f["startDate"][:10],
                "return": f["endDate"][:10],
            })
        if i % 50 == 0:
            log(f"  {i}/{len(routes)} routes, {len(rallies)} rallies so far")

    if routes and failures / len(routes) > MAX_FAILURE_RATE:
        raise RuntimeError(f"{failures} of {len(routes)} routes failed")

    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    rallies.sort(key=lambda r: (r["pickup"], r["from"], r["to"]))
    return {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stations": [slim_station(s) for s in stations if s["id"] in used],
        "rallies": rallies,
        "failed_routes": failures,
    }


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--locale", default="en", help="station name language: en or de (default en)")
    parser.add_argument("--delay", type=float, default=0.4, help="seconds between requests (default 0.4)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default web/data)")
    args = parser.parse_args()

    started = time.time()
    try:
        data = fetch_all(Client(args.locale, args.delay), lambda msg: print(msg, flush=True))
    except Exception as e:
        print(f"Fetch failed, existing data left unchanged: {e}", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    write_atomic(args.out / "rallies.json", body)
    # Same data as a script, so index.html also works when opened straight from disk.
    write_atomic(args.out / "rallies.js", f"window.RALLY_DATA = {body};\n")

    print(f"Saved {len(data['rallies'])} rallies at {len(data['stations'])} stations "
          f"to {args.out} in {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
