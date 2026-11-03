// Run with: node --test tests/matching.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { findRoundTrips, haversineKm, daysBetween, addDays, SAME_PLACE_KM } = require("../web/matching.js");

const BERLIN = { lat: 52.5200, lon: 13.4050 };

const stations = [
  { id: 6, name: "Berlin", lat: 52.5629, lon: 13.3256 },
  { id: 51, name: "Berlin-Schönefeld", lat: 52.3681, lon: 13.5614 },
  { id: 47, name: "Antwerp", lat: 51.1302, lon: 4.3772 },
  { id: 42, name: "Brussels", lat: 50.856, lon: 4.348 },
  { id: 3, name: "Hamburg", lat: 53.5401, lon: 10.0782 },
  { id: 1, name: "Munich", lat: 48.204, lon: 11.586 },
  { id: 20, name: "Madrid", lat: 40.395, lon: -3.581 },
  { id: 17, name: "Barcelona", lat: 41.3208, lon: 2.03 },
  { id: 48, name: "Antwerp-Port", lat: 51.23, lon: 4.42 }, // ~11 km from the Antwerp station
  { id: "imoova-1", provider: "imoova", name: "Antwerp", lat: 51.2194, lon: 4.4025 }, // city centre, ~10 km away
];

const rally = (from, to, pickup, ret) => ({ from, to, pickup, return: ret });
const last = (t) => t.legs[t.legs.length - 1];

const defaults = {
  home: BERLIN,
  startRadiusKm: 50,
  returnRadiusKm: 400,
  hopRadiusKm: 0,
  earliest: "2026-11-01",
  latest: "2026-12-31",
  maxWaitDays: 2,
  maxLegs: 2,
  sort: "start",
};

function find(rallies, overrides = {}) {
  return findRoundTrips({ stations, rallies }, { ...defaults, ...overrides });
}

test("date helpers", () => {
  assert.equal(daysBetween("2026-11-03", "2026-11-10"), 7);
  assert.equal(daysBetween("2026-10-24", "2026-10-26"), 2); // across the DST switch
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.ok(Math.abs(haversineKm(BERLIN, stations[2]) - 640) < 15);
});

test("finds outbound plus same-day return", () => {
  const trips = find([
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-10", "2026-11-17"),
  ]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].legs.length, 2);
  assert.deepEqual(trips[0].waits, [0]);
  assert.equal(trips[0].totalDays, 14);
  assert.ok(trips[0].endKm > 200 && trips[0].endKm < 300);
});

test("respects the maximum wait between legs", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-14", "2026-11-21"),
  ];
  assert.equal(find(rallies, { maxWaitDays: 2 }).length, 0);
  assert.equal(find(rallies, { maxWaitDays: 4 })[0].waitDays, 4);
});

test("ignores return legs that leave before you arrive", () => {
  const trips = find([
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-09", "2026-11-16"),
  ]);
  assert.equal(trips.length, 0);
});

test("return leg must end inside the return radius", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 1, "2026-11-10", "2026-11-17"), // Munich is ~505 km from Berlin
  ];
  assert.equal(find(rallies, { returnRadiusKm: 400 }).length, 0);
  assert.equal(find(rallies, { returnRadiusKm: 550 }).length, 1);
});

test("outbound leg must start inside the start radius", () => {
  const rallies = [
    rally(3, 20, "2026-11-03", "2026-11-10"), // Hamburg -> Madrid
    rally(20, 6, "2026-11-10", "2026-11-17"),
  ];
  assert.equal(find(rallies, { startRadiusKm: 50 }).length, 0);
  assert.equal(find(rallies, { startRadiusKm: 300 }).length, 1);
});

test("outbound legs that end inside the return area are skipped", () => {
  const trips = find([
    rally(51, 3, "2026-11-03", "2026-11-10"), // Berlin -> Hamburg is already home
    rally(3, 6, "2026-11-10", "2026-11-17"),
  ]);
  assert.equal(trips.length, 0);
});

test("hop radius lets the return leg start from a nearby station", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(42, 3, "2026-11-11", "2026-11-18"), // from Brussels, ~30 km from Antwerp
  ];
  assert.equal(find(rallies, { hopRadiusKm: 0 }).length, 0);
  const [trip] = find(rallies, { hopRadiusKm: 50 });
  assert.equal(last(trip).from, 42);
  assert.ok(trip.hops[0] > 20 && trip.hops[0] < 50);
});

test("whole trip must fit inside the date range", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-10", "2026-11-17"),
  ];
  assert.equal(find(rallies, { earliest: "2026-11-04" }).length, 0);
  assert.equal(find(rallies, { latest: "2026-11-16" }).length, 0);
  assert.equal(find(rallies, { earliest: "2026-11-03", latest: "2026-11-17" }).length, 1);
});

test("sorts by the chosen key", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-12", "2026-11-19"),
    rally(6, 20, "2026-11-05", "2026-11-12"),
    rally(20, 6, "2026-11-12", "2026-11-17"),
  ];
  const firstStops = (trips) => trips.map((t) => t.legs[0].to);
  assert.deepEqual(firstStops(find(rallies, { sort: "start" })), [47, 20]);
  assert.deepEqual(firstStops(find(rallies, { sort: "days" })), [20, 47]);
  assert.deepEqual(firstStops(find(rallies, { sort: "wait" })), [20, 47]);
});

// Berlin -> Madrid -> Barcelona -> Berlin
const threeLegs = [
  rally(51, 20, "2026-11-03", "2026-11-10"),
  rally(20, 17, "2026-11-10", "2026-11-17"),
  rally(17, 6, "2026-11-18", "2026-11-25"),
];

test("three-leg trips only appear when allowed", () => {
  assert.equal(find(threeLegs, { maxLegs: 2 }).length, 0);
  const trips = find(threeLegs, { maxLegs: 3 });
  assert.equal(trips.length, 1);
  assert.deepEqual(trips[0].legs.map((r) => r.to), [20, 17, 6]);
  assert.deepEqual(trips[0].waits, [0, 1]);
  assert.deepEqual(trips[0].hops, [0, 0]);
  assert.equal(trips[0].waitDays, 1);
  assert.equal(trips[0].totalDays, 22);
});

test("three-leg mode still lists two-leg trips", () => {
  const trips = find(
    [...threeLegs, rally(20, 3, "2026-11-11", "2026-11-18")], // Madrid -> Hamburg goes straight home
    { maxLegs: 3 }
  );
  assert.deepEqual(trips.map((t) => t.legs.length).sort(), [2, 3]);
});

test("a middle leg that already ends near home closes the trip", () => {
  const trips = find(
    [
      rally(51, 20, "2026-11-03", "2026-11-10"),
      rally(20, 3, "2026-11-10", "2026-11-17"), // Madrid -> Hamburg is home already
      rally(3, 6, "2026-11-17", "2026-11-20"),
    ],
    { maxLegs: 3 }
  );
  assert.equal(trips.length, 1);
  assert.equal(trips[0].legs.length, 2);
});

test("every leg of a three-leg trip respects wait and dates", () => {
  assert.equal(find(threeLegs, { maxLegs: 3, maxWaitDays: 0 }).length, 0); // 1 day wait in Barcelona
  assert.equal(find(threeLegs, { maxLegs: 3, latest: "2026-11-24" }).length, 0);
});

test("hops work between every pair of legs", () => {
  const trips = find(
    [
      rally(51, 20, "2026-11-03", "2026-11-10"),
      rally(20, 47, "2026-11-10", "2026-11-17"), // Madrid -> Antwerp
      rally(42, 6, "2026-11-17", "2026-11-24"), // Brussels -> Berlin
    ],
    { maxLegs: 3, hopRadiusKm: 50 }
  );
  assert.equal(trips.length, 1);
  assert.equal(trips[0].hops[0], 0);
  assert.ok(trips[0].hops[1] > 20 && trips[0].hops[1] < 50);
});

test("another provider's station in the same city connects without a train hop", () => {
  const [trip, ...rest] = find([
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally("imoova-1", 3, "2026-11-10", "2026-11-17"), // Imoova from Antwerp city centre
  ]);
  assert.equal(rest.length, 0);
  assert.equal(last(trip).from, "imoova-1");
  assert.ok(trip.hops[0] > 5 && trip.hops[0] < SAME_PLACE_KM);
});

test("nearby stations of the same provider still need a train hop", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(48, 3, "2026-11-10", "2026-11-17"), // from Antwerp-Port, ~11 km away
  ];
  assert.equal(find(rallies).length, 0);
  assert.equal(find(rallies, { hopRadiusKm: 20 }).length, 1);
});

test("offers that differ only in the return date are separate trips", () => {
  const trips = find([
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-10", "2026-11-16"),
    rally(47, 3, "2026-11-10", "2026-11-17"),
  ]);
  assert.equal(trips.length, 2);
  assert.notEqual(trips[0].id, trips[1].id);
});
