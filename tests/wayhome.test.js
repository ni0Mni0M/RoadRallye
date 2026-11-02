// Run with: node --test tests/wayhome.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../web/wayhome.js");

const MARBURG = { lat: 50.83, lon: 8.7708 };
const BERLIN = { lat: 52.5629, lon: 13.3256 };
const BREMEN = { lat: 53.068, lon: 8.948 };

const airports = [
  { iata: "FRA", lat: 50.0267, lon: 8.5584, routes: 239 },
  { iata: "KSF", lat: 51.4184, lon: 9.3916, routes: 2 },
  { iata: "BER", lat: 52.3617, lon: 13.5023, routes: 178 },
  { iata: "BRE", lat: 53.0468, lon: 8.7893, routes: 43 },
  { iata: "HAM", lat: 53.6304, lon: 9.9882, routes: 87 },
];

test("prefers a busy airport over a closer quiet one", () => {
  const ranked = W.rankAirports(MARBURG, airports);
  assert.equal(ranked[0].iata, "FRA");
  assert.ok(ranked.some((a) => a.iata === "KSF"));
});

test("takes the local airport when it has a decent number of flights", () => {
  assert.equal(W.rankAirports(BREMEN, airports)[0].iata, "BRE");
  assert.equal(W.rankAirports(BERLIN, airports)[0].iata, "BER");
});

test("plane estimate adds up the parts of the journey", () => {
  const p = W.planeEstimate(MARBURG, BERLIN, airports);
  assert.equal(p.dep.iata, "FRA");
  assert.equal(p.arr.iata, "BER");
  assert.equal(p.tooShort, false);
  const sum = p.toAirportMin + p.airportMin + p.flightMin + p.fromAirportMin;
  assert.ok(Math.abs(p.totalMin - sum) < 1e-9);
  assert.ok(p.totalMin > 4 * 60 && p.totalMin < 7 * 60, `got ${p.totalMin} min`);
});

test("plane estimate explains when flying is pointless", () => {
  const nearFrankfurt = { lat: 50.1, lon: 8.6 };
  assert.equal(W.planeEstimate(nearFrankfurt, MARBURG, airports).reason, "sameAirport");
  const atlantic = { lat: 45, lon: -30 };
  assert.equal(W.planeEstimate(atlantic, BERLIN, airports).reason, "noAirport");
  const hamburg = { lat: 53.54, lon: 10.08 };
  assert.equal(W.planeEstimate(hamburg, BREMEN, airports).tooShort, true);
});

test("transit estimate gives a sensible range", () => {
  const t = W.transitEstimate(MARBURG, BERLIN);
  assert.ok(t.lowMin < t.highMin);
  assert.ok(t.lowMin > 3.5 * 60 && t.lowMin < 5 * 60, `low ${t.lowMin}`);
  const short = W.transitEstimate({ lat: 52.52, lon: 13.4 }, { lat: 52.39, lon: 13.06 }); // Berlin -> Potsdam
  assert.ok(short.highMin < 2 * 60);
});

test("decodes Google polylines at any precision", () => {
  // The example from Google's polyline documentation.
  assert.deepEqual(W.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
  assert.deepEqual(W.decodePolyline("_p~iF~ps|U", 6), [[3.85, -12.02]]);
});

const itinerary = {
  duration: 20460,
  startTime: "2026-11-23T11:02:00Z",
  endTime: "2026-11-23T16:43:00Z",
  transfers: 2,
  legs: [
    { mode: "WALK", from: { tz: "Europe/Berlin" }, to: {} },
    { mode: "BUS", routeShortName: "481", displayName: "481", from: {}, to: {} },
    { mode: "REGIONAL_RAIL", routeShortName: "RE30", displayName: "RE30 (4156)", from: {}, to: {} },
    { mode: "HIGHSPEED_RAIL", routeShortName: "13", displayName: "ICE 798", from: {}, to: {} },
    { mode: "WALK", from: {}, to: { tz: "Europe/Berlin" } },
  ],
};

test("summarizes an itinerary with readable line names", () => {
  const s = W.summarizeItinerary(itinerary);
  assert.equal(s.durationMin, 341);
  assert.deepEqual(s.lines, ["Bus 481", "RE30 (4156)", "ICE 798"]);
  assert.equal(s.startTz, "Europe/Berlin");
  assert.equal(s.endTz, "Europe/Berlin");
});

test("finds the fastest connection", () => {
  assert.equal(W.fastestIndex([{ durationMin: 340 }, { durationMin: 300 }, { durationMin: 310 }]), 1);
  assert.equal(W.fastestIndex([]), -1);
});

test("fuel cost", () => {
  assert.equal(W.fuelCost(472, 7, 1.8).toFixed(2), "59.47");
});

test("links", () => {
  assert.equal(
    W.googleMapsUrl(MARBURG, BERLIN, "transit"),
    "https://www.google.com/maps/dir/?api=1&origin=50.83,8.7708&destination=52.5629,13.3256&travelmode=transit"
  );
  assert.equal(W.skyscannerUrl("FRA", "BER", "2026-12-02"), "https://www.skyscanner.net/transport/flights/fra/ber/261202/");
  assert.ok(W.googleFlightsUrl("FRA", "BER", "2026-12-02").includes("FRA%20to%20BER%20on%202026-12-02"));
});
