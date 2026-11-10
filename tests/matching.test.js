// Run with: node --test tests/matching.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { findTrips, findRoundTrips, haversineKm, daysBetween, addDays, SAME_PLACE_KM } = require("../web/matching.js");

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

// ---------- One-way trips ----------

function findOneWay(rallies, overrides = {}) {
  return findTrips({ stations, rallies }, { ...defaults, tripType: "oneway", maxLegs: 1, ...overrides });
}
const ends = (trips) => trips.map((t) => t.legs.map((r) => r.to).join(">"));

test("a one-way trip is a single rally out of the start area", () => {
  const trips = findOneWay([
    rally(51, 20, "2026-11-03", "2026-11-10"), // Berlin-Schönefeld -> Madrid
    rally(3, 20, "2026-11-03", "2026-11-10"), // Hamburg is outside the start area
  ]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].type, "oneway");
  assert.deepEqual(ends(trips), ["20"]);
  assert.deepEqual(trips[0].waits, []);
  assert.deepEqual(trips[0].hops, []);
  assert.equal(trips[0].waitDays, 0);
  assert.equal(trips[0].totalDays, 7);
  assert.ok(trips[0].endKm > 1800 && trips[0].endKm < 1950);
});

test("a one-way trip needs no way back", () => {
  const rallies = [rally(51, 20, "2026-11-03", "2026-11-10")];
  assert.equal(find(rallies).length, 0); // one rally is no round trip
  assert.equal(findOneWay(rallies, { returnRadiusKm: 50 }).length, 1);
});

test("a one-way trip must fit inside the date range", () => {
  const rallies = [rally(51, 20, "2026-11-03", "2026-11-10")];
  assert.equal(findOneWay(rallies, { earliest: "2026-11-04" }).length, 0);
  assert.equal(findOneWay(rallies, { latest: "2026-11-09" }).length, 0);
  assert.equal(findOneWay(rallies, { earliest: "2026-11-03", latest: "2026-11-10" }).length, 1);
});

test("one-way chains are listed next to the shorter trips they extend", () => {
  // Berlin -> Madrid -> Barcelona -> Antwerp
  const rallies = [
    rally(51, 20, "2026-11-03", "2026-11-10"),
    rally(20, 17, "2026-11-10", "2026-11-17"),
    rally(17, 47, "2026-11-18", "2026-11-25"),
  ];
  assert.deepEqual(ends(findOneWay(rallies)), ["20"]);
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 2 })), ["20", "20>17"]);
  const trips = findOneWay(rallies, { maxLegs: 3 });
  assert.deepEqual(ends(trips), ["20", "20>17", "20>17>47"]);
  assert.deepEqual(trips[2].waits, [0, 1]);
  assert.deepEqual(trips[2].hops, [0, 0]);
  assert.equal(trips[2].totalDays, 22);
  // The day of waiting in Barcelona, and the date range, cut the chain short.
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 3, maxWaitDays: 0 })), ["20", "20>17"]);
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 3, latest: "2026-11-24" })), ["20", "20>17"]);
});

test("a one-way trip never ends back in the start area", () => {
  const rallies = [
    rally(51, 6, "2026-11-03", "2026-11-05"), // Berlin-Schönefeld -> Berlin, ~27 km
    rally(51, 20, "2026-11-03", "2026-11-10"),
    rally(20, 6, "2026-11-10", "2026-11-17"), // Madrid -> Berlin makes a round trip, not a one-way chain
  ];
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 3 })), ["20"]);
  // Even with "home station only", the stations right next to home count as home.
  const fromSchoenefeld = { maxLegs: 3, home: stations[1], startRadiusKm: 0 };
  assert.deepEqual(ends(findOneWay(rallies, fromSchoenefeld)), ["20"]);
});

test("a one-way chain never visits a place twice", () => {
  const rallies = [
    rally(51, 20, "2026-11-03", "2026-11-10"), // Berlin -> Madrid
    rally(20, 17, "2026-11-10", "2026-11-17"), // Madrid -> Barcelona
    rally(17, 20, "2026-11-17", "2026-11-24"), // Barcelona -> Madrid again
    rally(51, 47, "2026-11-03", "2026-11-10"), // Berlin -> Antwerp
    rally(47, 48, "2026-11-10", "2026-11-12"), // Antwerp -> Antwerp-Port is the same place
  ];
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 3 })).sort(), ["20", "20>17", "47"]);
});

test("one-way chains use train hops and the other provider's station in town", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"), // Berlin -> Antwerp
    rally(42, 20, "2026-11-11", "2026-11-18"), // Brussels -> Madrid, a train hop from Antwerp
    rally("imoova-1", 17, "2026-11-10", "2026-11-17"), // Imoova from Antwerp city centre -> Barcelona
  ];
  assert.deepEqual(ends(findOneWay(rallies, { maxLegs: 2 })).sort(), ["47", "47>17"]);
  const hopped = findOneWay(rallies, { maxLegs: 2, hopRadiusKm: 50 });
  assert.deepEqual(ends(hopped).sort(), ["47", "47>17", "47>20"]);
  const viaBrussels = hopped.find((t) => last(t).from === 42);
  assert.ok(viaBrussels.hops[0] > 20 && viaBrussels.hops[0] < 50);
});

test("one-way trips can be sorted by how far they take you", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"), // Antwerp, ~640 km from home
    rally(51, 20, "2026-11-05", "2026-11-12"), // Madrid, ~1,870 km
    rally(6, 17, "2026-11-07", "2026-11-14"), // Barcelona, ~1,500 km
  ];
  assert.deepEqual(ends(findOneWay(rallies, { sort: "start" })), ["47", "20", "17"]);
  assert.deepEqual(ends(findOneWay(rallies, { sort: "far" })), ["20", "17", "47"]);
  assert.deepEqual(ends(findOneWay(rallies, { sort: "distance" })), ["47", "17", "20"]);
});

test("round trips stay what they were, and every trip says its kind", () => {
  const rallies = [
    rally(51, 47, "2026-11-03", "2026-11-10"),
    rally(47, 3, "2026-11-10", "2026-11-17"),
  ];
  const [trip] = find(rallies);
  assert.equal(trip.type, "round");
  assert.deepEqual(findTrips({ stations, rallies }, defaults), find(rallies)); // "round" is the default
  // As one-way trips the same rallies are a trip to Antwerp and a chain on to Hamburg.
  const oneWay = findOneWay(rallies, { maxLegs: 2 });
  assert.deepEqual(ends(oneWay), ["47", "47>3"]);
  assert.ok(oneWay.every((t) => t.type === "oneway"));
});
