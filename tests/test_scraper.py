"""Run with: python -m unittest discover -s tests"""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))

import imoova  # noqa: E402
from fetch_rallies import drop_known_rallies, previous_part  # noqa: E402

LAS_VEGAS = {"id": "14", "name": "Las Vegas", "state": "US_NV", "lat": 36.1716, "lng": -115.1391}
MIAMI = {"id": "38", "name": "Miami", "state": "US_FL", "lat": 25.7617, "lng": -80.1918}
BILBAO = {"id": "90", "name": "Bilbao", "state": "ES", "lat": 43.263, "lng": -2.935}


def relocation(id, frm, to, first, last, days=12, fee=4900, rate=100, currency="USD"):
    """One relocation as Imoova's API returns it (only the fields the scraper asks for)."""
    return {
        "id": id,
        "earliest_departure_date": first,
        "latest_departure_date": last,
        "hire_units_allowed": days,
        "hire_unit_rate": rate,
        "booking_fee_amount": fee,
        "currency": currency,
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
        self.assertNotIn("supplier", rallies[0])

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
            [relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-03")], roadsurfer_ids={"1"}, today=date(2026, 11, 1)
        )
        self.assertEqual(rallies[0]["supplier"], "roadsurfer")

    def test_country_from_state(self):
        self.assertEqual(imoova.slim_station(LAS_VEGAS)["country"], "US")
        self.assertEqual(imoova.slim_station(BILBAO)["country"], "ES")


def imoova_part(relocations, roadsurfer_ids=()):
    rallies = imoova.to_rallies(relocations, roadsurfer_ids, today=date(2026, 11, 1))
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
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14")], roadsurfer_ids={"1"})
        result = drop_known_rallies(part, ROADSURFER)
        self.assertEqual(result["rallies"], [])
        self.assertEqual(result["stations"], [])

    def test_keeps_other_suppliers_on_the_same_route(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14")])
        self.assertEqual(len(drop_known_rallies(part, ROADSURFER)["rallies"]), 12)

    def test_keeps_roadsurfer_listing_on_other_dates(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-20", "2026-11-25")], roadsurfer_ids={"1"})
        self.assertEqual(len(drop_known_rallies(part, ROADSURFER)["rallies"]), 6)

    def test_keeps_everything_without_roadsurfer_data(self):
        part = imoova_part([relocation("1", LAS_VEGAS, MIAMI, "2026-11-03", "2026-11-14")], roadsurfer_ids={"1"})
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


if __name__ == "__main__":
    unittest.main()
