#!/usr/bin/env python3
"""Fetch every one-way relocation offer (roadsurfer rallies, Imoova and Movacar relocations) and save it for the web page.

Each source is fetched on its own (see roadsurfer.py, imoova.py and movacar.py). When one fails, its offers from the
last run are kept and marked as old, so one broken source never empties the page.

Only the Python standard library is used, so no pip install is needed.
"""

import argparse
import json
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import history
import imoova
import movacar
import progress
import roadsurfer
from common import Client, haversine_km
from rates import fetch_rates

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "data"
DEFAULT_HISTORY = Path(__file__).resolve().parent.parent / "history" / "rallies.csv"
SOURCES = ["roadsurfer", "imoova", "movacar"]
# bar label, what it counts
LABELS = {"roadsurfer": ("roadsurfer", "rallies"), "imoova": ("Imoova", "relocations"), "movacar": ("Movacar", "relocations")}

# A roadsurfer van on Imoova is the same offer as a rally when both ends are this close to the rally's
# stations. Looser than SAME_PLACE_KM in web/matching.js: roadsurfer's "Dallas" is in Fort Worth.
SAME_ROUTE_KM = 60


def fetch_source(name, client, args, log, bar=None):
    if name == "roadsurfer":
        return roadsurfer.fetch_all(client, log, args.locale, bar)
    if name == "movacar":
        return movacar.fetch_all(client, log, bar)
    return imoova.fetch_all(client, log, bar)


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


def drop_listed_rallies(movacar_part, roadsurfer_part):
    """Drop roadsurfer vans listed on Movacar that are a rally roadsurfer lists itself: the same days,
    between the same two places. Most of Movacar's offers are, and the rally is booked without a middleman."""
    if not movacar_part or not roadsurfer_part:
        return movacar_part
    rs = {s["id"]: s for s in roadsurfer_part["stations"]}
    mv = {s["id"]: s for s in movacar_part["stations"]}
    by_days = {}  # (pickup, return) -> roadsurfer's routes on those days
    for x in roadsurfer_part["rallies"]:
        if x["from"] in rs and x["to"] in rs:
            by_days.setdefault((x["pickup"], x["return"]), set()).add((x["from"], x["to"]))

    def listed(r):
        return r.get("supplier") == "roadsurfer" and any(
            haversine_km(mv[r["from"]], rs[frm]) <= SAME_ROUTE_KM and haversine_km(mv[r["to"]], rs[to]) <= SAME_ROUTE_KM
            for frm, to in by_days.get((r["pickup"], r["return"]), ())
        )

    rallies = [r for r in movacar_part["rallies"] if not listed(r)]
    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    return {**movacar_part, "rallies": rallies, "stations": [s for s in movacar_part["stations"] if s["id"] in used]}


def use_depot_addresses(imoova_part, movacar_part):
    """Move Imoova's stations to the depot Movacar names. Imoova only gives the city centre; Movacar
    gives the depot's address. When both list a van of the same rental company on the same route
    (both ends within SAME_ROUTE_KM), Imoova's two stations take the position of Movacar's.
    roadsurfer's vans are left alone: its own station list says where those are.

    An Imoova city that fits several depots takes the nearest. Every rally from that city moves
    with it, other companies' too.
    """
    if not imoova_part or not movacar_part:
        return imoova_part
    im = {s["id"]: s for s in imoova_part["stations"]}
    mv = {s["id"]: s for s in movacar_part["stations"]}
    routes = {}  # company -> Movacar's routes (from, to)
    for r in movacar_part["rallies"]:
        if r.get("supplier") and r["supplier"] != "roadsurfer" and r["from"] in mv and r["to"] in mv:
            routes.setdefault(r["supplier"], set()).add((r["from"], r["to"]))

    depots = {}  # Imoova station id -> (km, Movacar station), the nearest so far
    def note(imoova_id, movacar_id):
        km = haversine_km(im[imoova_id], mv[movacar_id])
        if imoova_id not in depots or km < depots[imoova_id][0]:
            depots[imoova_id] = (km, mv[movacar_id])

    for frm, to, company in {(r["from"], r["to"], r.get("supplier")) for r in imoova_part["rallies"]}:
        if frm not in im or to not in im:
            continue
        for mv_from, mv_to in routes.get(company, ()):
            if haversine_km(im[frm], mv[mv_from]) <= SAME_ROUTE_KM and haversine_km(im[to], mv[mv_to]) <= SAME_ROUTE_KM:
                note(frm, mv_from)
                note(to, mv_to)

    stations = [
        {**s, "lat": depots[s["id"]][1]["lat"], "lon": depots[s["id"]][1]["lon"]} if s["id"] in depots else s
        for s in imoova_part["stations"]
    ]
    return {**imoova_part, "stations": stations}


def fill_countries(part, others):
    """Give the stations that came without a country (Movacar's) the country of the nearest station
    in `others`, when there is one within SAME_ROUTE_KM. The rest stay without."""
    known = [s for s in others if s.get("country")]
    for s in part["stations"]:
        if s.get("country") or not known:
            continue
        nearest = min(known, key=lambda k: haversine_km(s, k))
        if haversine_km(s, nearest) <= SAME_ROUTE_KM:
            s["country"] = nearest["country"]


def carry_first_seen(data, previous):
    """Note the day each rally first showed up, so the page can show what's new.
    Rallies that were already there when tracking started get no date."""
    today = data["fetched_at"][:10]
    key = lambda r: (r["from"], r["to"], r["pickup"], r["return"])
    if previous and previous.get("tracking_since"):
        seen = {key(r): r.get("first_seen") for r in previous["rallies"]}
        data["tracking_since"] = previous["tracking_since"]
        for r in data["rallies"]:
            r["first_seen"] = seen[key(r)] if key(r) in seen else today
    else:
        data["tracking_since"] = today
        for r in data["rallies"]:
            r["first_seen"] = None


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--locale", default="en", help="roadsurfer station name language: en or de (default en)")
    parser.add_argument("--delay", type=float, default=0.4, help="seconds between requests (default 0.4)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default web/data)")
    parser.add_argument("--history", type=Path, default=DEFAULT_HISTORY,
                        help="list of every rally ever seen, new ones are added (default history/rallies.csv)")
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
            label, unit = LABELS[name]
            try:
                with progress.bar(label) as bar:
                    part = fetch_source(name, Client(args.delay), args, progress.say, bar)
                    bar.done(f"{len(part['rallies'])} {unit}")
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
    if "movacar" in parts:
        # Countries first, from every station the other sources fetched, also those that go unused.
        fill_countries(parts["movacar"], [s for name, part in parts.items() if name != "movacar" for s in part["stations"]])
        parts["movacar"] = drop_listed_rallies(parts["movacar"], parts.get("roadsurfer"))
    if "imoova" in parts:
        parts["imoova"] = use_depot_addresses(parts["imoova"], parts.get("movacar"))

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
    currencies = {r["currency"] for r in rallies if r.get("currency", "EUR") != "EUR"}
    if currencies:
        try:
            data["rates"] = fetch_rates(currencies)
            progress.item("exchange rates", ", ".join(sorted(currencies)))
        except Exception as e:
            progress.item("exchange rates", f"failed, keeping the previous ones: {e}", ok=False)
            if old and old.get("rates"):
                data["rates"] = old["rates"]

    args.out.mkdir(parents=True, exist_ok=True)
    carry_first_seen(data, old)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    write_atomic(args.out / "rallies.json", body)
    # Same data as a script, so index.html also works when opened straight from disk.
    write_atomic(args.out / "rallies.js", f"window.RALLY_DATA = {body};\n")

    try:
        progress.item("history", f"{history.append_new(args.history, data)} new rallies added to {args.history.name}")
    except Exception as e:  # the page's data is saved; a locked or broken history file shouldn't fail the run
        progress.item("history", f"not updated: {e}", ok=False)

    counts = ", ".join(f"{len(p['rallies'])} from {name}" for name, p in parts.items())
    progress.item("saved", f"{counts} at {len(data['stations'])} stations ({time.time() - started:.0f}s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
