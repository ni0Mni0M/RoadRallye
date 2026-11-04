"""roadsurfer rallies (one-way relocations), from the JSON endpoints behind booking.roadsurfer.com/rally.

Each endpoint needs an X-Requested-Alias header naming it, otherwise the server answers with a 404 page.

    stations                    rally.startStations   all stations (with coordinates)
    stations/<start>            rally.fetchRoutes     destinations reachable from <start>
    timeframes/<start>-<end>    rally.timeframes      bookable date windows for one route
"""

API = "https://booking.roadsurfer.com/api/{locale}/rally"

# Give up on the whole source if more than this share of routes fail.
MAX_FAILURE_RATE = 0.2

# Share of the progress bar for the destination lists, before the number of routes is known.
# It's about one request in six, so the bar hardly jumps when the date requests start.
DESTINATIONS_SHARE = 0.15


def slim_station(s):
    coord = s.get("coordinate") or {}
    city = s.get("city") or {}
    return {
        "id": s["id"],
        "provider": "roadsurfer",
        "name": s["name"],
        "city": city.get("name"),
        "country": city.get("country"),
        "lat": coord.get("latitude"),
        "lon": coord.get("longitude"),
    }


def fetch_all(client, log, locale="en", bar=None):
    """log(text) prints warnings; bar (a progress.Progress, optional) shows how far it got."""
    base = API.format(locale=locale)
    show = bar.update if bar else (lambda fraction, detail=None: None)

    def get(path, alias):
        return client.fetch(base + path, {"X-Requested-Alias": alias})

    show(0, "station list")
    stations = get("/stations", "rally.startStations")
    if not stations:
        raise RuntimeError("Station list came back empty")

    starts = [s for s in stations if s.get("one_way") and s.get("public") and s.get("enabled")]

    routes = []
    for i, s in enumerate(starts, 1):
        detail = get(f"/stations/{s['id']}", "rally.fetchRoutes") or {}
        for end in detail.get("returns") or []:
            routes.append((s["id"], end))
        show(DESTINATIONS_SHARE * i / len(starts), f"destinations {i}/{len(starts)} · {s['name']}")

    requests = len(starts) + len(routes)
    rallies, failures = [], 0
    for i, (start, end) in enumerate(routes, 1):
        try:
            frames = get(f"/timeframes/{start}-{end}", "rally.timeframes") or []
        except Exception as e:  # keep going; one bad route shouldn't sink the run
            failures += 1
            log(f"  ! {start}-{end}: {e}")
            continue
        finally:
            show((len(starts) + i) / requests, f"dates {i}/{len(routes)} · {len(rallies)} rallies")
        for f in frames:
            rallies.append({
                "from": start,
                "to": end,
                "pickup": f["startDate"][:10],
                "return": f["endDate"][:10],
            })

    if routes and failures / len(routes) > MAX_FAILURE_RATE:
        raise RuntimeError(f"{failures} of {len(routes)} routes failed")

    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    return {
        "stations": [slim_station(s) for s in stations if s["id"] in used],
        "rallies": rallies,
        "failed_routes": failures,
    }
