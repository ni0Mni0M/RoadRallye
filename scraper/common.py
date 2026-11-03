"""Helpers shared by the rally sources."""

import json
import math
import time
import urllib.error
import urllib.request

USER_AGENT = "rally-roundtrip-finder/1.0 (personal use; few requests per day)"


class Client:
    """JSON over HTTP, with a pause between requests and a few retries."""

    def __init__(self, delay):
        self.delay = delay
        self.requests = 0

    def fetch(self, url, headers=None, body=None, retries=3):
        """GET a JSON endpoint, or POST `body` as JSON. Returns None on 404."""
        req = urllib.request.Request(
            url,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})},
        )
        for attempt in range(retries):
            if self.requests:
                time.sleep(self.delay)
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if attempt == retries - 1:
                    raise
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                if attempt == retries - 1:
                    raise
            time.sleep(2 ** (attempt + 1))
        return None


def haversine_km(a, b):
    """Distance between two stations ({lat, lon}) in km, same formula as web/matching.js."""
    rad = math.pi / 180
    d_lat = (b["lat"] - a["lat"]) * rad
    d_lon = (b["lon"] - a["lon"]) * rad
    h = math.sin(d_lat / 2) ** 2 + math.cos(a["lat"] * rad) * math.cos(b["lat"] * rad) * math.sin(d_lon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))
