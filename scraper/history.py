"""One growing list of every rally ever scraped: history/rallies.csv, one row per connection.

A connection is a route on a pickup day with a return day. After each scrape the ones not in the file
yet are added at the end; rows already there are never changed, so the price and company are the ones
from the day the connection first showed up.
"""

import csv

COLUMNS = [
    "first_seen", "provider",
    "from_id", "from_name", "from_country", "from_lat", "from_lon",
    "to_id", "to_name", "to_country", "to_lat", "to_lon",
    "pickup", "return", "price", "currency", "supplier", "ref",
]


def key(row):
    return (str(row["from_id"]), str(row["to_id"]), row["pickup"], row["return"])


def to_row(rally, stations, today):
    start, end = stations.get(rally["from"], {}), stations.get(rally["to"], {})
    row = {
        "first_seen": today,
        "provider": start.get("provider"),
        "from_id": rally["from"],
        "to_id": rally["to"],
        **{k: rally.get(k) for k in ("pickup", "return", "price", "currency", "supplier", "ref")},
    }
    for side, station in (("from", start), ("to", end)):
        row[f"{side}_name"] = station.get("name")
        row[f"{side}_country"] = station.get("country")
        row[f"{side}_lat"] = station.get("lat")
        row[f"{side}_lon"] = station.get("lon")
    return row


def append_new(path, data):
    """Add the rallies in `data` (what fetch_rallies saves) that the file doesn't have yet.
    Returns how many were added."""
    known = set()
    if path.exists():
        with path.open(encoding="utf-8-sig", newline="") as f:
            known = {key(row) for row in csv.DictReader(f)}

    stations = {s["id"]: s for s in data["stations"]}
    today = data["fetched_at"][:10]
    new = []
    for rally in data["rallies"]:
        row = to_row(rally, stations, today)
        if key(row) not in known:
            known.add(key(row))
            new.append(row)
    if not new:
        return 0

    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = not path.exists()
    # The byte order mark at the start of a new file makes Excel read the city names as UTF-8.
    with path.open("a", encoding="utf-8-sig" if fresh else "utf-8", newline="") as f:
        writer = csv.DictWriter(f, COLUMNS)
        if fresh:
            writer.writeheader()
        writer.writerows(new)
    return len(new)
