"""Imoova relocations, from the GraphQL API behind imoova.com/deals.

Imoova is a marketplace where many rental companies list one-way relocations. A relocation can be
picked up on any day of a window and comes with a number of free days (or nights), so every
possible pickup day becomes one rally here, returned when the free days run out.
Stations are Imoova's cities (city-centre coordinates); the exact depot is only given after booking.
"""

from datetime import date, timedelta

API = "https://api.imoova.com/graphql?RelocationList"
REGIONS = ["EU", "US"]  # the same areas roadsurfer rallies cover
PAGE_SIZE = 50

# Imoova's supplier ids for roadsurfer itself (imoova.com/deals/usa?supplier_id=55 lists them).
ROADSURFER_SUPPLIERS = ["55"]

QUERY = """
query RelocationList($first: Int!, $page: Int, $regions: [Region!], $supplier_id: ID,
                     $status: [RelocationStatus!], $type: [RelocationType!]) {
  relocations(first: $first, page: $page, regions: $regions, supplier_id: $supplier_id,
              status: $status, type: $type) {
    paginatorInfo { hasMorePages }
    data {
      id
      earliest_departure_date
      latest_departure_date
      hire_units_allowed
      hire_unit_rate
      booking_fee_amount
      currency
      departureCity { id name state lat lng }
      deliveryCity { id name state lat lng }
    }
  }
}
"""


def fetch_relocations(client, **filters):
    """Every bookable relocation matching `filters` (regions, supplier_id), page by page."""
    found, page = [], 1
    while True:
        variables = {"first": PAGE_SIZE, "page": page, "status": ["READY"], "type": ["RELOCATION"], **filters}
        body = client.fetch(API, {"Content-Type": "application/json"}, {"query": QUERY, "variables": variables})
        if not body or body.get("errors") or not body.get("data"):
            raise RuntimeError(f"Imoova answered without relocations: {(body or {}).get('errors')}")
        result = body["data"]["relocations"]
        found += result["data"]
        if not result["paginatorInfo"]["hasMorePages"]:
            return found
        page += 1


def station_id(city):
    return f"imoova-{city['id']}"


def slim_station(city):
    return {
        "id": station_id(city),
        "provider": "imoova",
        "name": city["name"],
        "city": city["name"],
        "country": city["state"].split("_")[0],  # "PT" in Europe, "US_NV" in the US
        "lat": city["lat"],
        "lon": city["lng"],
    }


def to_rallies(relocations, roadsurfer_ids=(), today=None):
    """One rally per pickup day from today on. The same trip listed twice is kept once, the cheaper one.

    price is what the free days cost: the booking fee plus the daily rate (fuel, bond and extra days not included).
    """
    today = today or date.today()
    best = {}
    for r in relocations:
        days = max(1, r["hire_units_allowed"])
        price = (r["booking_fee_amount"] + days * r["hire_unit_rate"]) / 100
        day = max(date.fromisoformat(r["earliest_departure_date"]), today)
        last = date.fromisoformat(r["latest_departure_date"])
        while day <= last:
            rally = {
                "from": station_id(r["departureCity"]),
                "to": station_id(r["deliveryCity"]),
                "pickup": day.isoformat(),
                "return": (day + timedelta(days=days)).isoformat(),
                "ref": r["id"],
                "price": round(price, 2),
                "currency": r["currency"],
            }
            if r["id"] in roadsurfer_ids:
                rally["supplier"] = "roadsurfer"
            key = (rally["from"], rally["to"], rally["pickup"], rally["return"])
            if key not in best or rally["price"] < best[key]["price"]:
                best[key] = rally
            day += timedelta(days=1)
    return list(best.values())


def fetch_all(client, log):
    relocations = []
    for region in REGIONS:
        found = fetch_relocations(client, regions=[region])
        log(f"  {region}: {len(found)} relocations")
        relocations += found
    roadsurfer_ids = {r["id"] for s in ROADSURFER_SUPPLIERS for r in fetch_relocations(client, supplier_id=s)}
    log(f"  {len(roadsurfer_ids)} of them are roadsurfer vans")

    rallies = to_rallies(relocations, roadsurfer_ids)
    cities = {}
    for r in relocations:
        for city in (r["departureCity"], r["deliveryCity"]):
            cities[station_id(city)] = city
    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    return {
        "stations": [slim_station(c) for sid, c in cities.items() if sid in used],
        "rallies": rallies,
    }
