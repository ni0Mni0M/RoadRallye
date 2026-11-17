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

test("summarizes an itinerary without line names", () => {
  const s = W.summarizeItinerary(itinerary);
  assert.equal(s.durationMin, 341);
  assert.deepEqual(s.vehicles, ["train", "bus"]);
  assert.equal(s.overnight, false);
  assert.equal(s.lines, undefined);
  assert.equal(s.startTz, "Europe/Berlin");
  assert.equal(s.endTz, "Europe/Berlin");
  const rail = { ...itinerary, legs: itinerary.legs.filter((l) => l.mode !== "BUS") };
  assert.deepEqual(W.summarizeItinerary(rail).vehicles, ["train"]);
  const coach = { ...itinerary, legs: [{ mode: "COACH", from: {}, to: {} }] };
  assert.deepEqual(W.summarizeItinerary(coach).vehicles, ["bus"]);
});

test("lays a connection out step by step", () => {
  const at = (name, extra = {}) => ({ name, tz: "Europe/Berlin", ...extra });
  const legs = [
    { mode: "WALK", duration: 480, from: at("START"), to: at("Marburg Süd") },
    {
      mode: "BUS", displayName: "481", duration: 600, startTime: "2026-11-23T11:10:00Z", endTime: "2026-11-23T11:20:00Z",
      from: at("Marburg Süd"), to: at("Marburg Hbf"), tripTo: at("Marburg Hbf"),
    },
    { mode: "WALK", duration: 180, from: at("Marburg Hbf"), to: at("Marburg (Lahn)") },
    {
      mode: "REGIONAL_RAIL", displayName: "RE30", duration: 3600, startTime: "2026-11-23T11:31:00Z", endTime: "2026-11-23T12:31:00Z",
      from: at("Marburg (Lahn)", { track: "1" }), to: at("Kassel-Wilhelmshöhe", { track: "3" }), tripTo: at("Kassel Hbf"),
    },
    {
      mode: "HIGHSPEED_RAIL", displayName: "ICE 798", duration: 9000, startTime: "2026-11-23T12:45:00Z", endTime: "2026-11-23T15:15:00Z",
      from: at("Kassel-Wilhelmshöhe", { track: "2" }), to: at("Berlin Hbf"), tripTo: at("Berlin Gesundbrunnen"),
    },
    { mode: "WALK", duration: 120, from: at("Berlin Hbf"), to: at("END") },
  ];
  const steps = W.connectionSteps(legs);
  assert.deepEqual(steps.map((s) => s.type), [
    "walk", "stop", "ride", "stop", "change", "stop", "ride", "stop", "change", "stop", "ride", "stop",
  ]);
  assert.deepEqual(steps[0], { type: "walk", where: "start", durationMin: 8 });
  assert.deepEqual(steps[2], { type: "ride", kind: "bus", line: "Bus 481", towards: null, durationMin: 10 });
  // The stop changes its name, so the change says where to walk.
  assert.deepEqual(steps[4], { type: "change", durationMin: 11, walkMin: 3, to: "Marburg (Lahn)" });
  assert.deepEqual(steps[5], { type: "stop", time: "2026-11-23T11:31:00Z", tz: "Europe/Berlin", name: "Marburg (Lahn)", track: "1" });
  assert.deepEqual(steps[6], { type: "ride", kind: "train", line: "RE30", towards: "Kassel Hbf", durationMin: 60 });
  assert.deepEqual(steps[8], { type: "change", durationMin: 14, walkMin: 0, to: null });
  // The two-minute walk at the end is too short to mention.
  assert.equal(steps[steps.length - 1].name, "Berlin Hbf");
  assert.deepEqual(W.connectionSteps([legs[0]]), []);

  const rer = { ...legs[3], displayName: "D", agencyName: "RER" };
  assert.equal(W.connectionSteps([rer])[1].line, "RER D");
});

test("spots a night on the road by the local clock", () => {
  // Berlin is UTC+1 in November.
  assert.equal(W.isOvernight("2026-11-21T15:10:00Z", 13.5 * 60, "Europe/Berlin"), true); // 16:10 -> 05:40
  assert.equal(W.isOvernight("2026-11-21T07:04:00Z", 6 * 60, "Europe/Berlin"), false); // 08:04 -> 14:04
  assert.equal(W.isOvernight("2026-11-21T20:00:00Z", 3 * 60, "Europe/Berlin"), false); // 21:00 -> 00:00
  assert.equal(W.isOvernight("2026-11-21T20:00:00Z", 5 * 60, "Europe/Berlin"), true); // 21:00 -> 02:00
  assert.equal(W.isOvernight("2026-11-22T04:30:00Z", 4 * 60, "Europe/Berlin"), false); // 05:30 -> 09:30
  assert.equal(W.isOvernight("2026-11-22T04:30:00Z", 22 * 60, "Europe/Berlin"), true); // into the next night
  assert.equal(W.localDay("2026-11-21T23:30:00Z", "Europe/Berlin"), "2026-11-22");
});

const option = (start, hours, transfers, overnight = false) => ({
  start,
  durationMin: hours * 60,
  transfers,
  overnight,
  startTz: "Europe/Berlin",
});

test("puts the fastest connection of the two days first", () => {
  const found = [
    option("2026-11-21T11:34:00Z", 8.3, 3), // same day, many changes
    option("2026-11-21T15:10:00Z", 13.5, 2, true), // through the night
    option("2026-11-22T07:04:00Z", 6.1, 1), // next morning: fastest
    option("2026-11-22T09:04:00Z", 6.2, 1), // the same trip two hours later
    option("2026-11-22T13:00:00Z", 9, 4),
  ];
  // Fastest first, then the two best alternatives in the order they leave; the repeat is left out.
  assert.deepEqual(W.pickConnections(found), [2, 0, 4]);
  assert.deepEqual(W.pickConnections(found, 1), [2]);
});

test("prefers a day trip to a slightly shorter night trip", () => {
  const found = [
    option("2026-11-21T12:00:00Z", 5, 0),
    option("2026-11-21T20:00:00Z", 8, 1, true),
    option("2026-11-22T08:00:00Z", 9, 1),
    option("2026-11-22T10:00:00Z", 9.5, 1),
  ];
  assert.deepEqual(W.pickConnections(found), [0, 2, 3]);
});

test("a slightly better trip tomorrow doesn't push out a good one today", () => {
  const found = [
    option("2026-11-21T12:00:00Z", 6.3, 1), // today
    option("2026-11-21T14:30:00Z", 5.7, 3), // today, the fastest
    option("2026-11-22T07:30:00Z", 5.9, 1), // tomorrow, a little shorter than the first
    option("2026-11-23T07:30:00Z", 5.9, 1), // the same train the day after
  ];
  assert.deepEqual(W.pickConnections(found), [1, 0, 2]);
});

test("falls back to repeats when there is nothing else", () => {
  const found = [
    option("2026-11-21T12:00:00Z", 5, 0),
    option("2026-11-21T14:00:00Z", 5, 0),
    option("2026-11-21T16:00:00Z", 5, 0),
    option("2026-11-21T18:00:00Z", 5, 0),
  ];
  assert.deepEqual(W.pickConnections(found), [0, 1, 2]);
  assert.deepEqual(W.pickConnections(found.slice(0, 2)), [0, 1]);
  assert.deepEqual(W.pickConnections([]), []);
});

test("offers a flight only for a long way home abroad", () => {
  const airports = require("../web/airports.js");
  const madrid = { lat: 40.395, lon: -3.581, country: "ES" };
  const berlin = { lat: 52.525, lon: 13.3694, country: "DE" };
  const munich = { lat: 48.14, lon: 11.56, country: "DE" };
  const prague = { lat: 50.083, lon: 14.435, country: "CZ" };
  const long = { durationMin: 22 * 60, transfers: 8 };

  const flight = W.flightSearch(madrid, berlin, long, "2026-11-28", airports);
  assert.equal(flight.from.city, "Madrid");
  assert.equal(flight.to.city, "Berlin");
  assert.equal(flight.url, "https://www.skyscanner.net/transport/flights/mad/ber/261128/?adultsv2=1&currency=EUR");

  // Over 10 hours, or 10 changes, or no connection at all.
  assert.equal(W.flightSearch(madrid, berlin, { durationMin: 600, transfers: 3 }, "2026-11-28", airports), null);
  assert.ok(W.flightSearch(madrid, berlin, { durationMin: 601, transfers: 0 }, "2026-11-28", airports));
  assert.ok(W.flightSearch(madrid, berlin, { durationMin: 500, transfers: 10 }, "2026-11-28", airports));
  assert.ok(W.flightSearch(madrid, berlin, null, "2026-11-28", airports));
  // Never inside one country, however long the train takes.
  assert.equal(W.flightSearch(munich, berlin, long, "2026-11-28", airports), null);
  // Never under 500 km (Prague to Berlin is about 280).
  assert.equal(W.flightSearch(prague, berlin, long, "2026-11-28", airports), null);
  // No airport within reach of the start.
  const nowhere = { lat: 46.5, lon: 2.5, country: "FR" };
  assert.equal(W.flightSearch(nowhere, berlin, long, "2026-11-28", airports), null);
  // A city with several airports uses Skyscanner's code for the whole city.
  const paris = { lat: 48.86, lon: 2.35, country: "FR" };
  assert.match(W.flightSearch(paris, berlin, long, "2026-11-28", airports).url, /\/pari\/ber\/261128\//);

  const codes = new Set();
  for (const a of airports) {
    assert.match(a.code, /^[a-z]{3,4}$/);
    assert.ok(a.city && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180, a.code);
    codes.add(a.code);
  }
  assert.ok(codes.size > 100);
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
