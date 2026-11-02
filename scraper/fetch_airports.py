#!/usr/bin/env python3
"""Save airports with scheduled flights near roadsurfer stations, for the "way home by plane" option.

Sources:
  OurAirports (public domain), https://ourairports.com/data/ for locations
  OpenFlights route list (ODbL), https://openflights.org/data for how well connected each airport is.
  The route list is old (2014), so it is only used to rank airports, never to claim a flight exists.

Needs web/data/rallies.json from fetch_rallies.py, because only airports within MAX_KM of a
station are kept. Airports change rarely, so update-data.bat only runs this when the file is missing.
"""

import csv
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
ROUTES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat"
USER_AGENT = "rally-roundtrip-finder/1.0 (personal use)"
DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"
MAX_KM = 250
# Airports that replaced older ones after the 2014 route list was made.
SUCCESSORS = {"BER": ["TXL", "SXF"]}


def haversine_km(lat1, lon1, lat2, lon2):
    rad = math.pi / 180
    h = (math.sin((lat2 - lat1) * rad / 2) ** 2
         + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lon2 - lon1) * rad / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8")


def destinations_per_airport(routes_text):
    """Number of distinct airports reachable nonstop, per IATA code."""
    pairs = set()
    for row in csv.reader(io.StringIO(routes_text)):
        if len(row) > 4 and len(row[2]) == 3 and len(row[4]) == 3:
            pairs.add((row[2], row[4]))
    counts = {}
    for src, _ in pairs:
        counts[src] = counts.get(src, 0) + 1
    for new, old in SUCCESSORS.items():
        counts[new] = counts.get(new, 0) + sum(counts.get(code, 0) for code in old)
    return counts


def main():
    rallies = DATA_DIR / "rallies.json"
    if not rallies.exists():
        print("Run fetch_rallies.py first: airports are picked by distance to the rally stations.", file=sys.stderr)
        return 1
    stations = [s for s in json.loads(rallies.read_text("utf-8"))["stations"]
                if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float))]

    try:
        text = download(URL)
        routes = destinations_per_airport(download(ROUTES_URL))
    except Exception as e:
        print(f"Airport download failed: {e}", file=sys.stderr)
        return 1

    airports = []
    for row in csv.DictReader(io.StringIO(text)):
        if row["type"] not in ("large_airport", "medium_airport"):
            continue
        if row["scheduled_service"] != "yes" or not row["iata_code"]:
            continue
        try:
            lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
        except ValueError:
            continue
        if not any(haversine_km(lat, lon, s["lat"], s["lon"]) <= MAX_KM for s in stations):
            continue
        airports.append({
            "iata": row["iata_code"],
            "name": row["name"],
            "city": row["municipality"],
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "routes": routes.get(row["iata_code"], 0),
        })

    airports.sort(key=lambda a: a["iata"])
    body = json.dumps(airports, ensure_ascii=False, separators=(",", ":"))
    (DATA_DIR / "airports.json").write_text(body, encoding="utf-8")
    (DATA_DIR / "airports.js").write_text(f"window.AIRPORT_DATA = {body};\n", encoding="utf-8")
    print(f"Saved {len(airports)} airports to {DATA_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
