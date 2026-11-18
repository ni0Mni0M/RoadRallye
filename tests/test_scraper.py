"""Run with: python -m unittest discover -s tests"""

import csv
import http.client
import io
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))

import history  # noqa: E402
import imoova  # noqa: E402
import movacar  # noqa: E402
from common import Client  # noqa: E402
from fetch_rallies import drop_known_rallies, drop_listed_rallies, fill_countries, previous_part  # noqa: E402
from rates import parse_ecb  # noqa: E402

LAS_VEGAS = {"id": "14", "name": "Las Vegas", "state": "US_NV", "lat": 36.1716, "lng": -115.1391}
MIAMI = {"id": "38", "name": "Miami", "state": "US_FL", "lat": 25.7617, "lng": -80.1918}
BILBAO = {"id": "90", "name": "Bilbao", "state": "ES", "lat": 43.263, "lng": -2.935}
INDIE = {"id": "12", "name": "IC - USA"}
ROADSURFER_USA = {"id": "55", "name": "Roadsurfer USA"}


def relocation(id, frm, to, first, last, days=12, fee=4900, rate=100, currency="USD", supplier=INDIE):
    """One relocation as Imoova's API returns it (only the fields the scraper asks for)."""
    return {
        "id": id,
        "earliest_departure_date": first,
        "latest_departure_date": last,
        "hire_units_allowed": days,
        "hire_unit_rate": rate,
        "booking_fee_amount": fee,
        "currency": currency,
        "supplier": supplier,
        "departureCity": frm,
        "deliveryCity": to,
    }


class ToRallies(unittest.TestCase):
    def test_one_rally_per_pickup_day(self):
        rallies = imoova.to_rallies([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-05")], today=date(2026, 11, 1))
        self.assertEqual([r["pickup"] for r in rallies], ["2026-11-03", "2026-11-04", "2026-11-05"])
        self.assertEqual(rallies[0]["return"], "2026-11-15")
        self.assertEqual(rallies[0]["from"], "imoova-14")
        self.assertEqual(rallies[0]["to"], "imoova-38")
        self.assertEqual(rallies[0]["price"], 61)  # $49 booking fee + 12 days at $1
        self.assertEqual(rallies[0]["ref"], "1")
        self.assertEqual(rallies[0]["supplier"], "Indie Campers")

    def test_skips_pickup_days_before_today(self):
        rallies = imoova.to_rallies([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-05")], today=date(2026, 11, 4))
        self.assertEqual([r["pickup"] for r in rallies], ["2026-11-04", "2026-11-05"])

    def test_same_trip_twice_keeps_the_cheaper_one(self):
        rallies = imoova.to_rallies(
            [
                relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03", fee=9900),
                relocation("2", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03", fee=4900),
            ],
            today=date(2026, 11, 1),
        )
        self.assertEqual(len(rallies), 1)
        self.assertEqual(rallies[0]["ref"], "2")

    def test_marks_roadsurfer_vans(self):
        rallies = imoova.to_rallies(
            [relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03", supplier=ROADSURFER_USA)],
            today=date(2026, 11, 1),
        )
        self.assertEqual(rallies[0]["supplier"], "roadsurfer")

    def test_no_supplier_field_without_a_supplier(self):
        rallies = imoova.to_rallies(
            [relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03", supplier=None)], today=date(2026, 11, 1)
        )
        self.assertNotIn("supplier", rallies[0])

    def test_company_names_without_region(self):
        names = {
            "IC - West Europe": "Indie Campers",
            "IC - UKIN": "Indie Campers",
            "McRent (UK)": "McRent",
            "Travellers Auto Barn USA": "Travellers Auto Barn",
            "El Monte": "El Monte",
            "Siesta Campers": "Siesta Campers",
        }
        for name, expected in names.items():
            self.assertEqual(imoova.company({"id": "1", "name": name}), expected)

    def test_country_from_state(self):
        self.assertEqual(imoova.slim_station(LAS_VEGAS)["country"], "US")
        self.assertEqual(imoova.slim_station(BILBAO)["country"], "ES")


def imoova_part(relocations):
    rallies = imoova.to_rallies(relocations, today=date(2026, 11, 1))
    stations = [imoova.slim_station(c) for c in (LAS_VEGAS, MIAMI, BILBAO)]
    return {"stations": stations, "rallies": rallies}


ROADSURFER = {
    "stations": [
        {"id": 76, "provider": "roadsurfer", "name": "Las Vegas", "lat": 36.08, "lon": -115.17},  # ~10 km out of town
        {"id": 119, "provider": "roadsurfer", "name": "Miami", "lat": 25.79, "lon": -80.29},
    ],
    "rallies": [{"from": 76, "to": 119, "pickup": "2026-11-02", "return": "2026-11-14"}],
}


class DropKnownRallies(unittest.TestCase):
    def test_drops_roadsurfer_listing_that_is_already_a_rally(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14", supplier=ROADSURFER_USA)])
        result = drop_known_rallies(part, ROADSURFER)
        self.assertEqual(result["rallies"], [])
        self.assertEqual(result["stations"], [])

    def test_keeps_other_suppliers_on_the_same_route(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14")])
        self.assertEqual(len(drop_known_rallies(part, ROADSURFER)["rallies"]), 12)

    def test_keeps_roadsurfer_listing_on_other_dates(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-20", "2026-11-25", supplier=ROADSURFER_USA)])
        self.assertEqual(len(drop_known_rallies(part, ROADSURFER)["rallies"]), 6)

    def test_keeps_everything_without_roadsurfer_data(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14", supplier=ROADSURFER_USA)])
        self.assertIs(drop_known_rallies(part, None), part)


class PreviousPart(unittest.TestCase):
    def test_data_from_before_sources_is_roadsurfer(self):
        old = {
            "fetched_at": "2026-11-01T07:00:00Z",
            "stations": [{"id": 76, "name": "Las Vegas"}, {"id": 119, "name": "Miami"}],
            "rallies": [{"from": 76, "to": 119, "pickup": "2026-11-02", "return": "2026-11-14"}],
        }
        part = previous_part(old, "roadsurfer")
        self.assertEqual(len(part["rallies"]), 1)
        self.assertEqual(part["fetched_at"], "2026-11-01T07:00:00Z")
        self.assertIsNone(previous_part(old, "imoova"))

    def test_keeps_each_sources_own_date(self):
        old = {
            "fetched_at": "2026-11-03T07:00:00Z",
            "sources": {"imoova": {"fetched_at": "2026-11-01T07:00:00Z"}},
            "stations": [imoova.slim_station(LAS_VEGAS), imoova.slim_station(MIAMI)],
            "rallies": imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03")])["rallies"],
        }
        part = previous_part(old, "imoova")
        self.assertEqual(part["fetched_at"], "2026-11-01T07:00:00Z")
        self.assertEqual(len(part["rallies"]), 1)


def scrape(day, rallies):
    """What fetch_rallies saves: the roadsurfer rally plus the given Imoova ones."""
    part = imoova_part(rallies)
    return {
        "fetched_at": f"{day}T07:00:00Z",
        "stations": ROADSURFER["stations"] + part["stations"],
        "rallies": ROADSURFER["rallies"] + part["rallies"],
    }


class History(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "history" / "rallies.csv"

    def rows(self):
        with self.path.open(encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    def test_first_run_adds_every_rally(self):
        added = history.append_new(self.path, scrape("2026-11-01", [relocation("1", LAS_VEGAS, BILBAO, "2026-11-03", "2026-11-04")]))
        self.assertEqual(added, 3)
        rows = self.rows()
        self.assertEqual(list(rows[0]), history.COLUMNS)
        self.assertEqual(rows[0]["provider"], "roadsurfer")
        self.assertEqual((rows[0]["from_id"], rows[0]["from_name"], rows[0]["price"]), ("76", "Las Vegas", ""))
        imoova_row = rows[1]
        self.assertEqual(imoova_row["provider"], "imoova")
        self.assertEqual((imoova_row["to_name"], imoova_row["to_country"]), ("Bilbao", "ES"))
        self.assertEqual((imoova_row["pickup"], imoova_row["return"]), ("2026-11-03", "2026-11-15"))
        self.assertEqual((imoova_row["price"], imoova_row["currency"], imoova_row["ref"]), ("61.0", "USD", "1"))
        self.assertEqual(imoova_row["supplier"], "Indie Campers")
        self.assertEqual({r["first_seen"] for r in rows}, {"2026-11-01"})

    def test_same_scrape_again_adds_nothing(self):
        data = scrape("2026-11-01", [relocation("1", LAS_VEGAS, BILBAO, "2026-11-03", "2026-11-04")])
        history.append_new(self.path, data)
        before = self.path.read_bytes()
        self.assertEqual(history.append_new(self.path, data), 0)
        self.assertEqual(self.path.read_bytes(), before)

    def test_later_scrape_adds_only_the_new_ones_and_keeps_the_old_rows(self):
        history.append_new(self.path, scrape("2026-11-01", [relocation("1", LAS_VEGAS, BILBAO, "2026-11-03", "2026-11-04")]))
        # A day later: the pickup on the 3rd is gone, the 5th is new, and the 4th costs more now.
        later = scrape("2026-11-02", [relocation("1", LAS_VEGAS, BILBAO, "2026-11-04", "2026-11-05", fee=9900)])
        self.assertEqual(history.append_new(self.path, later), 1)
        rows = self.rows()
        self.assertEqual([r["pickup"] for r in rows], ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"])
        self.assertEqual([r["first_seen"] for r in rows], ["2026-11-01"] * 3 + ["2026-11-02"])
        self.assertEqual(rows[2]["price"], "61.0")  # as first seen, not the new price

    def test_same_rally_twice_in_one_scrape_is_added_once(self):
        data = scrape("2026-11-01", [])
        data["rallies"] = data["rallies"] * 2
        self.assertEqual(history.append_new(self.path, data), 1)

    def test_keeps_names_with_commas_and_umlauts(self):
        data = scrape("2026-11-01", [])
        data["stations"] = [{**data["stations"][0], "name": "Köln, Flughafen"}] + data["stations"][1:]
        history.append_new(self.path, data)
        self.assertEqual(self.rows()[0]["from_name"], "Köln, Flughafen")


LOGOS = "https://storage.googleapis.com/movacar-prod-assets/"
PRICES = {
    "100-EUR": {"amount_minor_units": 100, "currency": "EUR"},
    "12900-EUR": {"amount_minor_units": 12900, "currency": "EUR"},
}


def offer(id, origin, destination, start, end, price="12900-EUR", logo="roadsurfer.png", kind=movacar.CAMPER):
    """One offer as Movacar's API returns it (only the fields the scraper reads)."""
    return {
        "id": f"{id}_1_2",
        "attributes": {
            "offer_id": id,
            "start_date": start,
            "end_date": end,
            "vehicle_type": kind,
            "brand_image_url": LOGOS + logo if logo else None,
        },
        "relationships": {
            "base_price": {"data": {"id": price, "type": "monetary_amount"}},
            "origin": {"data": {"id": origin, "type": "station"}},
            "destination": {"data": {"id": destination, "type": "station"}},
        },
    }


# The week from Monday 23 November, in Central European Time.
WEEK = ("2026-11-22T23:00:00Z", "2026-11-29T22:59:59Z")


class Movacar(unittest.TestCase):
    def test_days_are_central_european(self):
        self.assertEqual(movacar.local_day("2026-11-22T23:00:00Z"), "2026-11-23")  # winter: midnight
        self.assertEqual(movacar.local_day("2026-11-30T22:59:59Z"), "2026-11-30")
        self.assertEqual(movacar.local_day("2026-07-05T22:00:00Z"), "2026-07-06")  # summer: midnight
        self.assertEqual(movacar.local_day("2026-07-12T21:59:59Z"), "2026-07-12")
        self.assertEqual(movacar.local_day("2026-03-29T00:30:00Z"), "2026-03-29")  # half an hour before the clocks change
        self.assertEqual(movacar.local_day("2026-10-24T22:00:00Z"), "2026-10-25")  # last night of summer time

    def test_offer_becomes_a_rally(self):
        rallies = movacar.to_rallies([offer("257296", "2296", "2287", *WEEK)], PRICES)
        self.assertEqual(rallies, [{
            "from": "movacar-2296", "to": "movacar-2287", "pickup": "2026-11-23", "return": "2026-11-29",
            "ref": "257296", "price": 129.0, "currency": "EUR", "supplier": "roadsurfer",
        }])

    def test_cars_are_left_out(self):
        self.assertEqual(movacar.to_rallies([offer("1", "1", "2", *WEEK, kind="crowd_vehicle_type_0")], PRICES), [])

    def test_same_route_and_days_twice_keeps_the_cheaper(self):
        offers = [offer("1", "1", "2", *WEEK), offer("2", "1", "2", *WEEK, price="100-EUR"), offer("3", "1", "2", *WEEK)]
        rallies = movacar.to_rallies(offers, PRICES)
        self.assertEqual([(r["ref"], r["price"]) for r in rallies], [("2", 1.0)])

    def test_company_comes_from_the_logo(self):
        for logo, expected in [
            ("roadsurfer.png", "roadsurfer"),
            ("IndieCampers.svg", "Indie Campers"),
            ("SixtLogo.png", "Sixt"),
            ("Europcar.png", "Europcar"),
            (None, None),
        ]:
            self.assertEqual(movacar.company(offer("1", "1", "2", *WEEK, logo=logo)), expected)

    def test_offer_without_a_known_price_has_none(self):
        rally = movacar.to_rallies([offer("1", "1", "2", *WEEK, price="unknown")], PRICES)[0]
        self.assertNotIn("price", rally)

    def test_station_keeps_the_city_for_the_booking_link(self):
        station = movacar.slim_station("5428", {
            "alternative_city": "Kastorf (near Lübeck)", "city": "Kastorf", "latitude": 53.75, "longitude": 10.56,
        })
        self.assertEqual(station, {
            "id": "movacar-5428", "provider": "movacar", "name": "Kastorf (near Lübeck)", "city": "Kastorf",
            "lat": 53.75, "lon": 10.56,
        })


HAMBURG = {"id": 3, "provider": "roadsurfer", "name": "Hamburg", "country": "DE", "lat": 53.63, "lon": 10.0}
BORDEAUX = {"id": 20, "provider": "roadsurfer", "name": "Bordeaux", "country": "FR", "lat": 44.83, "lon": -0.7}
RALLIES = {
    "stations": [HAMBURG, BORDEAUX],
    "rallies": [{"from": 3, "to": 20, "pickup": "2026-11-23", "return": "2026-11-30"}],
}


def movacar_part(*rallies):
    return {
        "stations": [
            {"id": "movacar-1", "provider": "movacar", "name": "Hamburg", "lat": 53.55, "lon": 10.0},  # ~9 km away
            {"id": "movacar-2", "provider": "movacar", "name": "Bordeaux", "lat": 44.84, "lon": -0.58},
            {"id": "movacar-3", "provider": "movacar", "name": "Split", "lat": 43.51, "lon": 16.44},
        ],
        "rallies": [
            {"from": frm, "to": to, "pickup": pickup, "return": back, "ref": "1", "supplier": supplier}
            for frm, to, pickup, back, supplier in rallies
        ],
    }


class DropListedRallies(unittest.TestCase):
    def test_drops_a_roadsurfer_van_that_is_roadsurfers_own_rally(self):
        part = movacar_part(("movacar-1", "movacar-2", "2026-11-23", "2026-11-30", "roadsurfer"))
        result = drop_listed_rallies(part, RALLIES)
        self.assertEqual(result["rallies"], [])
        self.assertEqual(result["stations"], [])

    def test_keeps_other_days_other_routes_and_other_companies(self):
        part = movacar_part(
            ("movacar-1", "movacar-2", "2026-11-24", "2026-12-01", "roadsurfer"),
            ("movacar-2", "movacar-1", "2026-11-23", "2026-11-30", "roadsurfer"),
            ("movacar-1", "movacar-2", "2026-11-23", "2026-11-30", "Indie Campers"),
            ("movacar-1", "movacar-3", "2026-11-23", "2026-11-30", "roadsurfer"),
        )
        result = drop_listed_rallies(part, RALLIES)
        self.assertEqual(len(result["rallies"]), 4)
        self.assertEqual(len(result["stations"]), 3)

    def test_keeps_everything_without_roadsurfer_data(self):
        part = movacar_part(("movacar-1", "movacar-2", "2026-11-23", "2026-11-30", "roadsurfer"))
        self.assertIs(drop_listed_rallies(part, None), part)


class FillCountries(unittest.TestCase):
    def test_takes_the_country_of_a_station_nearby(self):
        part = movacar_part()
        fill_countries(part, [HAMBURG, BORDEAUX])
        self.assertEqual([s.get("country") for s in part["stations"]], ["DE", "FR", None])  # nothing near Split


ECB_SAMPLE = b"""<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time="2026-11-03">
      <Cube currency="USD" rate="1.1561"/>
      <Cube currency="GBP" rate="0.8712"/>
    </Cube>
  </Cube>
</gesmes:Envelope>"""


class ParseEcb(unittest.TestCase):
    def test_reads_date_and_rates(self):
        self.assertEqual(parse_ecb(ECB_SAMPLE), {"date": "2026-11-03", "per_eur": {"USD": 1.1561, "GBP": 0.8712}})

    def test_file_without_rates_fails(self):
        with self.assertRaises(ValueError):
            parse_ecb(b"<Envelope><Cube/></Envelope>")


DROPPED = http.client.RemoteDisconnected("Remote end closed connection without response")


@mock.patch("common.time.sleep")
class ClientFetch(unittest.TestCase):
    def test_retries_a_dropped_connection(self, _sleep):
        with mock.patch("common.urllib.request.urlopen", side_effect=[DROPPED, io.BytesIO(b'{"ok": true}')]) as urlopen:
            self.assertEqual(Client(0).fetch("https://example.invalid/x"), {"ok": True})
        self.assertEqual(urlopen.call_count, 2)

    def test_gives_up_after_the_last_retry(self, _sleep):
        with mock.patch("common.urllib.request.urlopen", side_effect=[DROPPED] * 3) as urlopen:
            with self.assertRaises(http.client.RemoteDisconnected):
                Client(0).fetch("https://example.invalid/x")
        self.assertEqual(urlopen.call_count, 3)


if __name__ == "__main__":
    unittest.main()
