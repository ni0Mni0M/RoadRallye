"""Euro exchange rates from the European Central Bank, so the page can show every price in euros."""

import urllib.request
import xml.etree.ElementTree as ET

from common import USER_AGENT

ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"


def parse_ecb(xml):
    """{"date": "2026-11-03", "per_eur": {"USD": 1.1561, ...}}: how much of each currency one euro buys."""
    day, per_eur = None, {}
    for cube in ET.fromstring(xml).iter():
        if "time" in cube.attrib:
            day = cube.attrib["time"]
        if "currency" in cube.attrib:
            per_eur[cube.attrib["currency"]] = float(cube.attrib["rate"])
    if not day or not per_eur:
        raise ValueError("no rates in the ECB file")
    return {"date": day, "per_eur": per_eur}


def fetch_rates(currencies):
    """Today's ECB rates for `currencies` (EUR itself is left out)."""
    req = urllib.request.Request(ECB_DAILY, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        rates = parse_ecb(resp.read())
    rates["per_eur"] = {c: r for c, r in rates["per_eur"].items() if c in currencies}
    return rates
