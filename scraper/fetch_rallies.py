#!/usr/bin/env python3
"""Fetch every one-way relocation offer (roadsurfer rallies, Imoova relocations) and save it for the web page.

Each source is fetched on its own (see roadsurfer.py and imoova.py). When one fails, its offers from the
last run are kept and marked as old, so one broken source never empties the page.

Only the Python standard library is used, so no pip install is needed.
"""

import argparse
import json
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import imoova
import roadsurfer
from common import Client, haversine_km

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "data"
SOURCES = ["roadsurfer", "imoova"]

# A roadsurfer van on Imoova is the same offer as a rally when both ends are this close to the rally's
# stations. Looser than SAME_PLACE_KM in web/matching.js: roadsurfer's "Dallas" is in Fort Worth.
SAME_ROUTE_KM = 60


def fetch_source(name, client, args, log):
    if name == "roadsurfer":
        return roadsurfer.fetch_all(client, log, args.locale)
    return imoova.fetch_all(client, log)


def previous_part(old, name):
    """The stations and rallies one source had in the saved data, or None.

    Data saved before there were several sources has no provider fields: all of it is roadsurfer's.
    """
    if not old:
        return None
    stations = [{**s, "provider": name} for s in old.get("stations", []) if s.get("provider", "roadsurfer") == name]
    if not stations:
        return None
    ids = {s["id"] for s in stations}
    info = (old.get("sources") or {}).get(name) or {"fetched_at": old.get("fetched_at")}
    return {
        "stations": stations,
        "rallies": [r for r in old.get("rallies", []) if r["from"] in ids],
        "fetched_at": info.get("fetched_at"),
    }


def drop_known_rallies(imoova_part, roadsurfer_part):
    """Drop roadsurfer vans listed on Imoova when roadsurfer has a rally on the same route around the same days."""
    if not imoova_part or not roadsurfer_part:
        return imoova_part
    rs = {s["id"]: s for s in roadsurfer_part["stations"]}
    im = {s["id"]: s for s in imoova_part["stations"]}
    listings = {}  # Imoova ref -> (from, to, first pickup, last pickup)
    for r in imoova_part["rallies"]:
        if r.get("supplier") == "roadsurfer":
            _, _, first, last = listings.get(r["ref"], (None, None, r["pickup"], r["pickup"]))
            listings[r["ref"]] = (r["from"], r["to"], min(first, r["pickup"]), max(last, r["pickup"]))

    def near(imoova_id, roadsurfer_id):
        return roadsurfer_id in rs and haversine_km(im[imoova_id], rs[roadsurfer_id]) <= SAME_ROUTE_KM

    def day(iso):
        return date.fromisoformat(iso).toordinal()

    known = {
        ref
        for ref, (frm, to, first, last) in listings.items()
        if any(
            near(frm, x["from"]) and near(to, x["to"]) and day(first) - 2 <= day(x["pickup"]) <= day(last) + 2
            for x in roadsurfer_part["rallies"]
        )
    }
    rallies = [r for r in imoova_part["rallies"] if r.get("ref") not in known]
    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    return {**imoova_part, "rallies": rallies, "stations": [s for s in imoova_part["stations"] if s["id"] in used]}


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--locale", default="en", help="roadsurfer station name language: en or de (default en)")
    parser.add_argument("--delay", type=float, default=0.4, help="seconds between requests (default 0.4)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default web/data)")
    parser.add_argument("--source", action="append", choices=SOURCES,
                        help="only fetch this source and keep the others' saved data (repeatable)")
    args = parser.parse_args()

    started = time.time()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        old = json.loads((args.out / "rallies.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = None

    parts, failed = {}, []
    for name in SOURCES:
        if args.source and name not in args.source:
            part = previous_part(old, name)
        else:
            print(f"--- {name}", flush=True)
            try:
                part = fetch_source(name, Client(args.delay), args, lambda msg: print(msg, flush=True))
                part["fetched_at"] = now
            except Exception as e:
                print(f"{name} failed, keeping its previous data: {e}", file=sys.stderr)
                failed.append(name)
                part = previous_part(old, name)
                if part:
                    part["error"] = str(e)[:200]
        if part:
            parts[name] = part

    if not parts:
        print("No data from any source, existing data left unchanged", file=sys.stderr)
        return 1

    if "imoova" in parts:
        parts["imoova"] = drop_known_rallies(parts["imoova"], parts.get("roadsurfer"))

    sources = {
        name: {k: part[k] for k in ("fetched_at", "error", "failed_routes") if part.get(k) is not None}
        for name, part in parts.items()
    }
    rallies = [r for part in parts.values() for r in part["rallies"]]
    rallies.sort(key=lambda r: (r["pickup"], str(r["from"]), str(r["to"])))
    data = {
        "fetched_at": max((s["fetched_at"] for s in sources.values() if s.get("fetched_at")), default=now),
        "sources": sources,
        "stations": [s for part in parts.values() for s in part["stations"]],
        "rallies": rallies,
    }

    args.out.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    write_atomic(args.out / "rallies.json", body)
    # Same data as a script, so index.html also works when opened straight from disk.
    write_atomic(args.out / "rallies.js", f"window.RALLY_DATA = {body};\n")

    counts = ", ".join(f"{len(p['rallies'])} from {name}" for name, p in parts.items())
    print(f"Saved {counts} at {len(data['stations'])} stations to {args.out} in {time.time() - started:.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
