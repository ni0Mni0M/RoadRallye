#!/usr/bin/env python3
"""Typical weather per station and month, used to rank destinations by season.

Source: Open-Meteo historical weather API (free for non-commercial use, CC BY 4.0),
https://open-meteo.com/. For every station: average daily high, rainy days (1 mm or more)
and hours of sunshine per day, for each month of 2024 and 2025.

Writes web/data/climate.json and climate.js. Stations already in the file are skipped, so after
the first run this only fetches new stations.
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import progress

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"
USER_AGENT = "RoadRalley/1.0 (seasonal ranking for a personal rally planner)"
YEARS = (2024, 2025)
URL = ("https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
       f"&start_date={YEARS[0]}-01-01&end_date={YEARS[-1]}-12-31"
       "&daily=temperature_2m_max,precipitation_sum,sunshine_duration&timezone=auto")
# Multi-year requests count as many calls in Open-Meteo's fair-use limits (600 a minute,
# 5,000 an hour), so go slowly.
PAUSE = 6


def monthly(daily):
    by_month = [{"t": [], "rain": 0, "sun": []} for _ in range(12)]
    for day, t, rain, sun in zip(daily["time"], daily["temperature_2m_max"],
                                 daily["precipitation_sum"], daily["sunshine_duration"]):
        m = by_month[int(day[5:7]) - 1]
        if t is not None:
            m["t"].append(t)
        if rain is not None and rain >= 1:
            m["rain"] += 1
        if sun is not None:
            m["sun"].append(sun / 3600)
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    return [{"t": avg(m["t"]), "rain": round(m["rain"] / len(YEARS), 1), "sun": avg(m["sun"])} for m in by_month]


def write(data):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for name, text in (("climate.json", body), ("climate.js", f"window.CLIMATE_DATA = {body};\n")):
        tmp = DATA_DIR / (name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(DATA_DIR / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=0, help="only fetch this many new stations (for testing)")
    args = parser.parse_args()

    stations = [s for s in json.loads((DATA_DIR / "rallies.json").read_text("utf-8"))["stations"] if s.get("lat") is not None]
    path = DATA_DIR / "climate.json"
    data = json.loads(path.read_text("utf-8")) if path.exists() else {"period": f"{YEARS[0]}–{YEARS[-1]}", "stations": {}}
    todo = [s for s in stations if str(s["id"]) not in data["stations"]]
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        progress.item("weather", f"all {len(stations)} stations already saved")
        return 0

    failures = 0
    with progress.bar("weather") as bar:
        for i, s in enumerate(todo, 1):
            bar.update((i - 1) / len(todo), f"{i}/{len(todo)} · {s['name']}")
            req = urllib.request.Request(URL.format(lat=s["lat"], lon=s["lon"]), headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data["stations"][str(s["id"])] = monthly(json.load(resp)["daily"])
            except Exception as e:
                failures += 1
                progress.say(f"  ! {s['name']}: {e}")
            if i % 10 == 0:
                write(data)
            if i < len(todo):
                time.sleep(PAUSE)

        write(data)
        bar.done(f"{len(todo) - failures} new, {len(data['stations'])} stations saved" + (f", {failures} failed" if failures else ""))
    return 0 if failures <= len(todo) // 5 else 1


if __name__ == "__main__":
    sys.exit(main())
