"""Run with: python -m unittest discover -s tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))

from fetch_route_info import add_positions, needs_positions  # noqa: E402

BERLIN = {"id": 6, "lat": 52.52, "lon": 13.40}
VIENNA = {"id": 36, "lat": 48.21, "lon": 16.37}

# As load_pois returns them: {id: {"name", "points": [[lat, lon, part name or None], ...]}}, grid index.
REFS = {
    "parks": ({"Q1": {"name": "Saxon Switzerland", "points": [[50.92, 14.17, "Saxon Switzerland"]]}}, {}),
    "unesco": (
        {
            "whc1": {
                "name": "Ore Mountains",
                "points": [
                    [50.60, 13.00, "Ore Mountains"],  # far west of the Berlin-Vienna line
                    [50.40, 14.90, "Ore Mountains"],  # right next to it
                    [50.50, 14.90, "Freiberg"],  # another part, with its own name
                ],
            },
        },
        {},
    ),
}


class AddPositions(unittest.TestCase):
    def route(self):
        return {"parks": [["Q1", "Saxon Switzerland"]], "unesco": [["whc1", "Ore Mountains"], ["whc9", "Gone"]]}

    def test_old_routes_need_positions(self):
        self.assertTrue(needs_positions(self.route()))
        self.assertFalse(needs_positions({"parks": [["Q1", "Saxon Switzerland", 50.92, 14.17]], "unesco": []}))

    def test_places_each_site_at_its_part_nearest_the_line(self):
        info = self.route()
        self.assertEqual(add_positions(info, BERLIN, VIENNA, REFS), 2)
        self.assertEqual(info["parks"], [["Q1", "Saxon Switzerland", 50.92, 14.17]])
        self.assertEqual(info["unesco"][0], ["whc1", "Ore Mountains", 50.4, 14.9])

    def test_sites_missing_from_the_reference_data_are_marked_and_not_tried_again(self):
        info = self.route()
        add_positions(info, BERLIN, VIENNA, REFS)
        self.assertEqual(info["unesco"][1], ["whc9", "Gone", None, None])
        self.assertFalse(needs_positions(info))

    def test_placed_sites_stay_as_they_are(self):
        info = {"parks": [["Q1", "Saxon Switzerland", 1.0, 2.0]], "unesco": []}
        self.assertEqual(add_positions(info, BERLIN, VIENNA, REFS), 0)
        self.assertEqual(info["parks"], [["Q1", "Saxon Switzerland", 1.0, 2.0]])


if __name__ == "__main__":
    unittest.main()
