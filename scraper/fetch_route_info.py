#!/usr/bin/env python3
"""Road distance, countries and scenery along every rally route, used to rank destinations.

For each pair of stations connected by a rally (worked out once, then cached):
  road route         public OSRM server: distance, driving time and shape
  mountains          Open-Meteo elevation API: highest point, km above 1,000 m
  countries crossed  Natural Earth 1:50m borders (public domain)
  coast              km within 5 km of the Natural Earth 1:50m coastline
  national parks     within 10 km (Wikidata, CC0)
  UNESCO sites       World Heritage sites within 10 km (OpenStreetMap via Overpass, ODbL)

Writes web/data/routes.json and routes.js. Reference downloads are kept in scraper/cache/.
Only the Python standard library is used.
"""

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import progress

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "web" / "data"
CACHE_DIR = Path(__file__).resolve().parent / "cache"
USER_AGENT = "RoadRalley/1.0 (route scenery for a personal rally planner)"

OSRM = "https://router.project-osrm.org/route/v1/driving/{a};{b}?overview=simplified&geometries=geojson"
ELEVATION = "https://api.open-meteo.com/v1/elevation?latitude={lats}&longitude={lons}"
NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
WIKIDATA = "https://query.wikidata.org/sparql"
OVERPASS = "https://overpass-api.de/api/interpreter"
EUROPE_BBOX = "34,-11,72,40"  # south, west, north, east

SAMPLE_KM = 5          # spacing of the points checked along each route
ELEVATION_EVERY = 2    # elevation for every 2nd point, so every 10 km
COAST_KM = 5
POI_KM = 10
MOUNTAIN_M = 1000

PARKS_SPARQL = (
    "SELECT ?item ?itemLabel ?coord WHERE { ?item wdt:P31/wdt:P279* wd:Q46169; wdt:P625 ?coord; "
    "wdt:P17 ?country. ?country wdt:P30 wd:Q46. "
    "SERVICE wikibase:label { bd:serviceParam wikibase:language \"en,de,fr,es,it\". } }"
)
UNESCO_OVERPASS = f'[out:json][timeout:180];nwr["heritage:operator"="whc"]({EUROPE_BBOX});out center tags;'


def get_json(url, timeout=60, retries=3, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if attempt == retries - 1:
                raise
            # 429 = too many requests: wait as long as the server asks (Wikidata may want a minute).
            wait = int(e.headers.get("Retry-After") or 65) if e.code == 429 else 3 * (attempt + 1)
            progress.say(f"  {urllib.parse.urlsplit(url).hostname} busy ({e.code}), waiting {wait}s")
            time.sleep(wait)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(3 * (attempt + 1))


def cached(name, fetch):
    """Return cache/<name>.json, downloading it with fetch() the first time."""
    path = CACHE_DIR / f"{name}.json"
    if path.exists():
        return json.loads(path.read_text("utf-8"))
    CACHE_DIR.mkdir(exist_ok=True)
    data = fetch()
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


# ---------- geometry (lat/lon in degrees, distances in km) ----------

def km_between(a, b):
    rad = math.pi / 180
    h = (math.sin((b[0] - a[0]) * rad / 2) ** 2
         + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin((b[1] - a[1]) * rad / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def resample(path, step_km):
    """Points every step_km along a [(lat, lon), ...] line, including both ends."""
    points = [path[0]]
    carried = 0.0
    for a, b in zip(path, path[1:]):
        seg = km_between(a, b)
        pos = step_km - carried
        while pos <= seg:
            t = pos / seg
            points.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            pos += step_km
        carried = (carried + seg) % step_km
    if points[-1] != path[-1]:
        points.append(path[-1])
    return points


def segment_km(p, a, b):
    """Distance from p to segment a-b, on a local flat projection (fine below ~100 km)."""
    k = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * 111.32 * k, (a[0] - p[0]) * 110.57
    bx, by = (b[1] - p[1]) * 111.32 * k, (b[0] - p[0]) * 110.57
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


def in_ring(lat, lon, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


CELL = 0.5  # degrees, for the grid indexes below


def cell(lat, lon):
    return (math.floor(lat / CELL), math.floor(lon / CELL))


def neighbours(lat, lon):
    r, c = cell(lat, lon)
    return [(r + dr, c + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1)]


# ---------- reference data ----------

def load_countries():
    data = cached("ne_50m_admin_0_countries", lambda: get_json(NE_BASE + "ne_50m_admin_0_countries.geojson", timeout=180))
    countries = []
    for f in data["features"]:
        p = f["properties"]
        code = next((p.get(k) for k in ("ISO_A2_EH", "ISO_A2", "WB_A2") if len(str(p.get(k) or "")) == 2 and p.get(k) != "-9"), None)
        if not code:
            continue
        g = f["geometry"]
        polygons = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polygons:
            xs = [pt[0] for pt in poly[0]]
            ys = [pt[1] for pt in poly[0]]
            countries.append({"code": code, "poly": poly, "bbox": (min(ys), max(ys), min(xs), max(xs))})
    # Small areas first, so enclaves (San Marino, Vatican, Monaco...) win over the country around them.
    countries.sort(key=lambda c: (c["bbox"][1] - c["bbox"][0]) * (c["bbox"][3] - c["bbox"][2]))
    return countries


def country_at(countries, lat, lon):
    for c in countries:
        s, n, w, e = c["bbox"]
        if s <= lat <= n and w <= lon <= e and in_ring(lat, lon, c["poly"][0]) \
                and not any(in_ring(lat, lon, hole) for hole in c["poly"][1:]):
            return c["code"]
    return None


def load_coast():
    data = cached("ne_50m_coastline", lambda: get_json(NE_BASE + "ne_50m_coastline.geojson", timeout=180))
    grid = {}
    for f in data["features"]:
        g = f["geometry"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for line in lines:
            for (x1, y1), (x2, y2) in zip(line, line[1:]):
                seg = ((y1, x1), (y2, x2))
                for r in range(math.floor(min(y1, y2) / CELL), math.floor(max(y1, y2) / CELL) + 1):
                    for c in range(math.floor(min(x1, x2) / CELL), math.floor(max(x1, x2) / CELL) + 1):
                        grid.setdefault((r, c), []).append(seg)
    return grid


def fetch_parks():
    url = WIKIDATA + "?" + urllib.parse.urlencode({"query": PARKS_SPARQL, "format": "json"})
    rows = get_json(url, timeout=120, headers={"Accept": "application/sparql-results+json"})["results"]["bindings"]
    pois = {}
    for row in rows:
        qid = row["item"]["value"].rsplit("/", 1)[-1]
        lon, lat = row["coord"]["value"].removeprefix("Point(").removesuffix(")").split()
        pois[qid] = {"name": row["itemLabel"]["value"], "lat": float(lat), "lon": float(lon)}
    return pois


def fetch_unesco():
    body = urllib.parse.urlencode({"data": UNESCO_OVERPASS}).encode()
    req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):  # the shared Overpass server is often busy for a moment
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                elements = json.load(resp)["elements"]
            break
        except urllib.error.HTTPError as e:
            if attempt == 3 or e.code not in (429, 502, 503, 504):
                raise
            progress.say(f"  Overpass busy ({e.code}), retrying in 30s")
            time.sleep(30)
    pois = {}
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or lon is None:
            continue
        # Sites with several parts share one World Heritage number.
        key = f"whc{tags['ref:whc']}" if tags.get("ref:whc") else f"osm-{el['type']}{el['id']}"
        entry = pois.setdefault(key, {"name": tags.get("name:en") or tags.get("name") or "World Heritage site", "points": []})
        entry["points"].append([lat, lon])
    return pois


def merge_unesco_parts(pois):
    """OpenStreetMap maps many sites as separate parts: numbered like 1465-009 (part 9 of site 1465),
    or without a number at all. Numbered parts are grouped by site; unnumbered ones join the site
    within 3 km, and unnamed leftovers are dropped."""
    unnamed = "World Heritage site"
    part_name = lambda part: part["name"] if part["name"] != unnamed else None
    numbered = {}
    for key, part in pois.items():
        site_no = re.match(r"whc(\d+)", key)
        if not site_no:
            continue
        site = numbered.setdefault(f"whc{site_no.group(1)}", {"name": None, "points": []})
        # Each point keeps its part's name: serial sites span countries, so the part near a route
        # says more than the first name found ("Baden-Baden" rather than "Vichy").
        site["points"] += [[lat, lon, part_name(part)] for lat, lon in part["points"]]
        if part_name(part) and (site["name"] is None or key == f"whc{site_no.group(1)}"):  # the site's own name wins
            site["name"] = part["name"]
    for key, site in numbered.items():
        site["name"] = site["name"] or f"{unnamed} {key[3:]}"
    grid = {}
    for key, site in numbered.items():
        for lat, lon, _ in site["points"]:
            grid.setdefault(cell(lat, lon), []).append((key, lat, lon))
    merged = dict(numbered)
    for key, part in pois.items():
        if key in numbered or re.match(r"whc\d", key):
            continue
        lat, lon = part["points"][0]
        near = min(((km_between((lat, lon), (a, b)), k) for c in neighbours(lat, lon) for k, a, b in grid.get(c, [])), default=None)
        if near and near[0] <= 3:
            merged[near[1]]["points"].append([lat, lon, part_name(part)])
        elif part_name(part):
            merged[key] = {"name": part["name"], "points": [[lat, lon, part["name"]]]}
    return merged


def load_pois(kind):
    """{id: {"name", "points": [[lat, lon, part name or None], ...]}} plus a grid index of the points."""
    if kind == "parks":
        pois = {qid: {"name": p["name"], "points": [[p["lat"], p["lon"], p["name"]]]}
                for qid, p in cached("wikidata_parks", fetch_parks).items()}
    else:
        pois = merge_unesco_parts(cached("osm_unesco", fetch_unesco))
    grid = {}
    for pid, p in pois.items():
        for lat, lon, name in p["points"]:
            grid.setdefault(cell(lat, lon), []).append((pid, lat, lon, name))
    return pois, grid


# ---------- per route ----------

def describe_route(a, b, refs, pause):
    route = get_json(OSRM.format(a=f"{a['lon']},{a['lat']}", b=f"{b['lon']},{b['lat']}"))
    if route.get("code") != "Ok" or not route.get("routes"):
        raise RuntimeError(route.get("code", "no route"))
    r = route["routes"][0]
    path = [(lat, lon) for lon, lat in r["geometry"]["coordinates"]]
    samples = resample(path, SAMPLE_KM)

    codes = [country_at(refs["countries"], lat, lon) for lat, lon in samples]
    counts = {}
    for code in codes:
        if code:
            counts[code] = counts.get(code, 0) + 1
    # In order of travel. Brushes with a border shorter than ~10 km don't count, both ends always do.
    crossed = []
    for i, code in enumerate(codes):
        if code and code not in crossed and (counts[code] >= 2 or i in (0, len(codes) - 1)):
            crossed.append(code)

    coast_points = 0
    for p in samples:
        segs = [s for key in neighbours(*p) for s in refs["coast"].get(key, [])]
        if any(segment_km(p, s[0], s[1]) <= COAST_KM for s in segs):
            coast_points += 1

    # id -> (km, name of the nearest part), so each site is named after what you actually pass.
    found = {"parks": {}, "unesco": {}}
    for kind, hits in found.items():
        pois, grid = refs[kind]
        for p in samples:
            for key in neighbours(*p):
                for pid, lat, lon, name in grid.get(key, []):
                    d = km_between(p, (lat, lon))
                    if d <= POI_KM and (pid not in hits or d < hits[pid][0]):
                        hits[pid] = (d, name or pois[pid]["name"])

    heights = []
    elev_points = samples[::ELEVATION_EVERY]
    for i in range(0, len(elev_points), 100):
        chunk = elev_points[i:i + 100]
        url = ELEVATION.format(lats=",".join(f"{p[0]:.4f}" for p in chunk), lons=",".join(f"{p[1]:.4f}" for p in chunk))
        heights += [h for h in get_json(url).get("elevation", []) if h is not None]
        time.sleep(pause / 4)

    return {
        "km": round(r["distance"] / 1000, 1),
        "min": round(r["duration"] / 60),
        "countries": crossed,
        "coastKm": coast_points * SAMPLE_KM,
        "mountainKm": sum(1 for h in heights if h >= MOUNTAIN_M) * SAMPLE_KM * ELEVATION_EVERY,
        "maxElevation": round(max(heights)) if heights else None,
        # [id, name] pairs: the id tells the app when two legs pass the same site.
        "parks": sorted([pid, name] for pid, (_, name) in found["parks"].items()),
        "unesco": sorted([pid, name] for pid, (_, name) in found["unesco"].items()),
    }


def write(data):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for name, text in (("routes.json", body), ("routes.js", f"window.ROUTE_DATA = {body};\n")):
        tmp = DATA_DIR / (name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(DATA_DIR / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=0, help="only work out this many new routes (for testing)")
    parser.add_argument("--pause", type=float, default=1.1, help="seconds between routing requests (OSRM asks for at most 1/s)")
    args = parser.parse_args()

    rallies = json.loads((DATA_DIR / "rallies.json").read_text("utf-8"))
    stations = {s["id"]: s for s in rallies["stations"] if s.get("lat") is not None}
    # Lower id first, as routeKey in web/ranking.js: roadsurfer's numbers, then Imoova's text ids.
    id_order = lambda x: (isinstance(x, str), x)
    pairs = sorted({tuple(sorted((r["from"], r["to"]), key=id_order)) for r in rallies["rallies"]
                    if r["from"] in stations and r["to"] in stations}, key=lambda p: tuple(map(id_order, p)))

    out_path = DATA_DIR / "routes.json"
    data = json.loads(out_path.read_text("utf-8")) if out_path.exists() else {"routes": {}}
    todo = [p for p in pairs if f"{p[0]}-{p[1]}" not in data["routes"]]
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        progress.item("routes", f"all {len(pairs)} already saved")
        return 0

    # Borders, coast, national parks and World Heritage sites: downloaded once (~10 MB), then from scraper/cache/.
    loaders = [
        ("countries", "borders", load_countries),
        ("coast", "coastline", load_coast),
        ("parks", "national parks", lambda: load_pois("parks")),
        ("unesco", "World Heritage sites", lambda: load_pois("unesco")),
    ]
    refs = {}
    with progress.bar("reference data") as bar:
        for i, (key, name, load) in enumerate(loaders):
            bar.update(i / len(loaders), name)
            refs[key] = load()
        bar.done("borders, coast, parks, World Heritage sites")

    failures = 0
    with progress.bar("routes") as bar:
        for i, (a, b) in enumerate(todo, 1):
            bar.update((i - 1) / len(todo), f"{i}/{len(todo)} · {stations[a]['name']} – {stations[b]['name']}")
            try:
                info = describe_route(stations[a], stations[b], refs, args.pause)
            except Exception as e:
                failures += 1
                progress.say(f"  ! {stations[a]['name']} - {stations[b]['name']}: {e}")
                continue
            data["routes"][f"{a}-{b}"] = info
            if i % 20 == 0:
                write(data)
            time.sleep(args.pause)

        data["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write(data)
        bar.done(f"{len(todo) - failures} new, {len(data['routes'])} saved" + (f", {failures} failed" if failures else ""))
    return 0 if failures < max(5, len(todo) // 5) else 1


if __name__ == "__main__":
    sys.exit(main())
