"""Movacar relocations, from the JSON API behind movacar.com/offers.

Movacar is a marketplace where rental companies list one-way relocations; most camper offers are
roadsurfer's own rallies, the rest mainly Indie Campers'. An offer is a window like a roadsurfer
rally: pick up on the first day at the earliest, hand back on the last day at the latest.

    locations/offers            every pickup and drop-off city that has offers
    offers?origin=<reference>   the offers from one city (and from stations close to it)

There is no request for all offers at once (a search by pickup date stops at 100), so each pickup
city is asked in turn. Stations come without a country; fetch_rallies fills it in from the
other sources' stations.
"""

from datetime import datetime, timedelta
from pathlib import PurePosixPath
from urllib.parse import urlsplit

API = "https://crowd-api-production-615013621295.europe-west1.run.app/v1"
CAMPER = "crowd_vehicle_type_5"  # the other types are cars and vans, mostly for a single day

# Give up on the whole source if more than this share of pickup cities fail.
MAX_FAILURE_RATE = 0.2

# The rental company is only named by its logo: ".../IndieCampers.svg", ".../SixtLogo.png".
BRANDS = {"roadsurfer": "roadsurfer", "IndieCampers": "Indie Campers"}


def local_day(stamp):
    """The day of an API time ("2026-11-22T23:00:00Z") in Central European time, which the offers'
    first and last days are set in: that one is midnight on the 23rd."""
    utc = datetime.fromisoformat(stamp.replace("Z", "+00:00")).replace(tzinfo=None)

    def last_sunday(month):  # 01:00 UTC, when the clocks change
        day = datetime(utc.year, month, 31, 1)
        return day - timedelta(days=(day.weekday() + 1) % 7)

    summer = last_sunday(3) <= utc < last_sunday(10)
    return (utc + timedelta(hours=2 if summer else 1)).date().isoformat()


def station_id(id):
    return f"movacar-{id}"


def slim_station(id, s):
    return {
        "id": station_id(id),
        "provider": "movacar",
        "name": s.get("alternative_city") or s["city"],  # "Kastorf (near Lübeck)"
        "city": s["city"],  # what movacar.com/offers/<city>/<city> is looked up by
        "lat": s["latitude"],
        "lon": s["longitude"],
    }


def company(offer):
    """The rental company's name, from its logo's file name. None without a logo."""
    logo = offer["attributes"].get("brand_image_url")
    if not logo:
        return None
    stem = PurePosixPath(urlsplit(logo).path).stem
    return BRANDS.get(stem) or stem.removesuffix("Logo") or None


def to_rallies(offers, prices):
    """One rally per camper offer. The same route and window listed twice (two vans) is kept once,
    the cheaper one.

    prices: the API's amounts by id, {"12900-EUR": {"amount_minor_units": 12900, "currency": "EUR"}}.
    price is the listed rent for the included days (fuel, extra days and extra km not included).
    """
    best = {}
    for o in offers:
        a = o["attributes"]
        if a.get("vehicle_type") != CAMPER:
            continue
        links = o["relationships"]
        rally = {
            "from": station_id(links["origin"]["data"]["id"]),
            "to": station_id(links["destination"]["data"]["id"]),
            "pickup": local_day(a["start_date"]),
            "return": local_day(a["end_date"]),
            "ref": a["offer_id"],
        }
        amount = prices.get(((links.get("base_price") or {}).get("data") or {}).get("id"))
        if amount:
            rally["price"] = round(amount["amount_minor_units"] / 100, 2)
            rally["currency"] = amount["currency"]
        supplier = company(o)
        if supplier:
            rally["supplier"] = supplier
        key = (rally["from"], rally["to"], rally["pickup"], rally["return"])
        known = best.get(key)
        if not known or rally.get("price", float("inf")) < known.get("price", float("inf")):
            best[key] = rally
    return list(best.values())


def fetch_all(client, log, bar=None):
    """log(text) prints warnings; bar (a progress.Progress, optional) shows how far it got."""
    if bar:
        bar.update(0, "city list")
    cities = client.fetch(f"{API}/locations/offers?locale=en") or {}
    origins = [c["attributes"] for c in cities.get("included") or [] if c["attributes"].get("location_type") == "origin"]
    if not origins:
        raise RuntimeError("City list came back empty")

    offers, stations, prices, failures = {}, {}, {}, 0
    for i, city in enumerate(origins, 1):
        try:
            page = client.fetch(f"{API}/offers?locale=en&origin={city['reference']}") or {}
        except Exception as e:  # keep going; one bad city shouldn't sink the run
            failures += 1
            log(f"  ! {city['name']}: {e}")
            page = {}
        # Cities close together return each other's offers: the id keeps each one once.
        for offer in page.get("data") or []:
            offers[offer["id"]] = offer
        for extra in page.get("included") or []:
            if extra["type"] == "station":
                stations[extra["id"]] = extra["attributes"]
            elif extra["type"] == "monetary_amount":
                prices[extra["id"]] = extra["attributes"]
        if bar:
            bar.update(i / len(origins), f"cities {i}/{len(origins)} · {len(offers)} offers")

    if failures / len(origins) > MAX_FAILURE_RATE:
        raise RuntimeError(f"{failures} of {len(origins)} cities failed")

    rallies = to_rallies(offers.values(), prices)
    used = {r["from"] for r in rallies} | {r["to"] for r in rallies}
    return {
        "stations": [slim_station(id, s) for id, s in stations.items() if station_id(id) in used],
        "rallies": rallies,
        "failed_routes": failures,
    }
