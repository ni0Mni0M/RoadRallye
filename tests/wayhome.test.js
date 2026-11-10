// Run with: node --test tests/wayhome.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../web/wayhome.js");

const MARBURG = { lat: 50.83, lon: 8.7708 };
const BERLIN = { lat: 52.5629, lon: 13.3256 };

test("the way home ends at the city's central station", () => {
  const centers = require("../web/centers.js");
  const depot = { id: 6, name: "Berlin", ...BERLIN };
  assert.equal(W.homePoint(depot, centers).name, "Berlin Hbf");
  // A station without an entry (an Imoova city centre, a new depot) stays as it is.
  const imoova = { id: "imoova-12", name: "Lisbon", lat: 38.72, lon: -9.14 };
  assert.equal(W.homePoint(imoova, centers), imoova);
  assert.equal(W.homePoint(depot, undefined), depot);
  for (const [id, c] of Object.entries(centers)) {
    assert.ok(c.name && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180, `entry ${id}`);
  }
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

test("Google Maps link", () => {
  assert.equal(
    W.googleMapsUrl(MARBURG, BERLIN, "transit"),
    "https://www.google.com/maps/dir/?api=1&origin=50.83,8.7708&destination=52.5629,13.3256&travelmode=transit"
  );
});
