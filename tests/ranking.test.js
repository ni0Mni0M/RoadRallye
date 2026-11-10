// Run with: node --test tests/ranking.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../web/matching.js");
const R = require("../web/ranking.js");

const stationList = [
  { id: 6, name: "Berlin", country: "DE", lat: 52.5629, lon: 13.3256 },
  { id: 51, name: "Berlin-Schönefeld", country: "DE", lat: 52.3681, lon: 13.5614 },
  { id: 20, name: "Madrid", country: "ES", lat: 40.395, lon: -3.581 },
  { id: 17, name: "Barcelona", country: "ES", lat: 41.3208, lon: 2.03 },
  { id: 47, name: "Antwerp", country: "BE", lat: 51.1302, lon: 4.3772 },
  { id: 3, name: "Hamburg", country: "DE", lat: 53.5401, lon: 10.0782 },
  { id: 22, name: "Marburg", country: "DE", lat: 50.83, lon: 8.7708 },
];
const stations = new Map(stationList.map((s) => [s.id, s]));
const rally = (from, to, pickup, ret, firstSeen = null) => ({ from, to, pickup, return: ret, first_seen: firstSeen });

const rallies = [
  rally(51, 20, "2026-11-03", "2026-11-10"), // to Madrid
  rally(20, 6, "2026-11-10", "2026-11-17"), // back from Madrid, same day
  rally(20, 22, "2026-11-12", "2026-11-19", "2026-11-04"), // or 2 days later to Marburg (new)
  rally(51, 17, "2026-11-05", "2026-11-12"), // to Barcelona
  rally(17, 3, "2026-11-13", "2026-11-20"), // back after 1 day
  rally(6, 47, "2026-11-07", "2026-11-14"), // to Antwerp
  rally(47, 6, "2026-11-14", "2026-11-21"), // back the same day
];

const trips = M.findRoundTrips(
  { stations: stationList, rallies },
  {
    home: { lat: 52.52, lon: 13.405 },
    startRadiusKm: 50,
    returnRadiusKm: 400,
    hopRadiusKm: 0,
    earliest: "2026-11-01",
    latest: "2026-12-31",
    maxWaitDays: 2,
    maxLegs: 2,
    sort: "start",
  }
);

// Stored once per pair, in the direction from the lower id to the higher one.
const routes = {
  "20-51": { km: 2300, countries: ["ES", "FR", "DE"], parks: [["Q1", "Park One"]], unesco: [["whc1", "Site One"]], coastKm: 0, mountainKm: 100 },
  "6-20": { km: 2320, countries: ["DE", "FR", "ES"], parks: [["Q1", "Park One"]], unesco: [], coastKm: 0, mountainKm: 80 },
  "20-22": { km: 1800, countries: ["ES", "FR", "DE"], parks: [], unesco: [], coastKm: 40, mountainKm: 0 },
  "17-51": { km: 1900, countries: ["ES", "FR", "CH", "DE"], parks: [], unesco: [["whc2", "Site Two"]], coastKm: 60, mountainKm: 20 },
  "3-17": { km: 1950, countries: ["DE", "FR", "ES"], parks: [], unesco: [], coastKm: 60, mountainKm: 0 },
  "6-47": { km: 750, countries: ["DE", "NL", "BE"], parks: [], unesco: [], coastKm: 0, mountainKm: 0 },
};
const costs = { rallyFee: 129, insurancePerDay: 15, vanLitresPer100Km: 10, fuelPrice: 1.8 };
const climate = {
  stations: {
    20: Array.from({ length: 12 }, () => ({ t: 19, rain: 4, sun: 6 })),
    17: Array.from({ length: 12 }, () => ({ t: 18, rain: 5, sun: 7 })),
    47: Array.from({ length: 12 }, () => ({ t: 10, rain: 13, sun: 2 })),
  },
};

function rank(by, extra = {}) {
  const ctx = { stations, routes, costs, facts: new Map() };
  for (const t of trips) ctx.facts.set(t.id, R.tripFacts(t, ctx));
  return R.rankStations(trips, ctx, {
    mode: "destinations",
    by,
    home: stations.get(6),
    today: "2026-11-01",
    freshSince: "2026-11-04",
    climate,
    ...extra,
  });
}

const names = (rows) => rows.map((r) => r.name);
const madridHome = () => trips.find((t) => t.legs[0].to === 20 && t.legs[1].to === 6);

test("fixture gives four trips", () => {
  assert.equal(trips.length, 4);
});

test("trip facts add up fees, insurance and van fuel", () => {
  const f = R.tripFacts(madridHome(), { stations, routes, costs });
  // 2 × (129 fee + 7 days × 15) + (2300 + 2320) km × 10 l/100 km × 1.80 €/l
  assert.equal(f.cost.toFixed(2), (2 * (129 + 105) + 4620 * 0.1 * 1.8).toFixed(2));
  assert.equal(f.roadKm, 4620);
  assert.equal(f.rallyDays, 14);
  assert.equal(f.kmPerDay, 330);
});

test("countries come out in travel order, whichever way a route is stored", () => {
  const f = R.tripFacts(madridHome(), { stations, routes, costs });
  assert.deepEqual(f.countries, ["DE", "FR", "ES"]);
});

test("a site passed on two legs only counts once", () => {
  const f = R.tripFacts(madridHome(), { stations, routes, costs });
  assert.deepEqual(f.parks, ["Park One"]);
  assert.equal(f.scenic, 1 * 3 + 1 * 2 + (180 / 20));
});

test("without route data distances are estimated and there is no scenic score", () => {
  const f = R.tripFacts(madridHome(), { stations, routes: null, costs });
  assert.equal(f.measured, false);
  assert.equal(f.scenic, null);
  assert.ok(f.roadKm > 3500 && f.roadKm < 6000);
});

test("each leg keeps its own distance, countries and scenery, in travel order", () => {
  const timed = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, { ...v, min: 1200, maxElevation: 1400 }]));
  const f = R.tripFacts(madridHome(), { stations, routes: timed, costs });
  assert.equal(f.legs.length, 2);
  assert.deepEqual(f.legs[0], {
    from: 51, to: 20, km: 2300, measured: true, drivingMin: 1200, countries: ["DE", "FR", "ES"],
    parks: ["Park One"], unesco: ["Site One"], coastKm: 0, mountainKm: 100, maxElevation: 1400,
  });
  assert.deepEqual(f.legs[1].countries, ["ES", "FR", "DE"]);
  assert.equal(f.drivingMin, 2400);
  assert.equal(f.drivingMinPerDay, 2400 / 14);
});

test("driving time is only given when every leg has route data", () => {
  const f = R.tripFacts(madridHome(), { stations, routes, costs }); // the fixture has no driving times
  assert.equal(f.drivingMin, null);
  assert.equal(f.drivingMinPerDay, null);
  const none = R.tripFacts(madridHome(), { stations, routes: null, costs });
  assert.equal(none.legs[0].measured, false);
  assert.deepEqual(none.legs[0].countries, ["DE", "ES"]);
});

test("sites with a position go on the map once, sites without one don't", () => {
  const placed = {
    ...routes,
    "20-51": { ...routes["20-51"], parks: [["Q1", "Park One", 42.1, -1.5]], unesco: [["whc1", "Site One", null, null]] },
    "6-20": { ...routes["6-20"], parks: [["Q1", "Park One", 42.1, -1.5]] },
  };
  const f = R.tripFacts(madridHome(), { stations, routes: placed, costs });
  assert.deepEqual(f.sites, [{ kind: "park", id: "Q1", name: "Park One", lat: 42.1, lon: -1.5 }]);
});

test("weather for a station in the month of a date", () => {
  assert.deepEqual(R.weatherFor(climate, 20, "2026-11-10"), { month: 10, t: 19, rain: 4, sun: 6 });
  assert.equal(R.weatherFor(climate, 6, "2026-11-10"), null);
  assert.equal(R.weatherFor(null, 20, "2026-11-10"), null);
});

test("route keys put roadsurfer's numeric ids before Imoova's text ids", () => {
  assert.equal(R.routeKey(20, 6), "6-20");
  assert.equal(R.routeKey("imoova-5", 20), "20-imoova-5");
  assert.equal(R.routeKey(20, "imoova-5"), "20-imoova-5");
  assert.equal(R.routeKey("imoova-5", "imoova-12"), "imoova-12-imoova-5");
});

test("countries come out in travel order between a roadsurfer station and an Imoova city", () => {
  const lisbon = { id: "imoova-9", name: "Lisbon", country: "PT", lat: 38.72, lon: -9.14 };
  const withLisbon = new Map([...stations, [lisbon.id, lisbon]]);
  const r = { "20-imoova-9": { km: 630, countries: ["ES", "PT"], parks: [], unesco: [], coastKm: 0, mountainKm: 0 } };
  const leg = (from, to) => ({ from, to, pickup: "2026-11-03", return: "2026-11-06" });
  const there = R.tripFacts({ legs: [leg(20, "imoova-9")], totalDays: 3 }, { stations: withLisbon, routes: r, costs });
  const back = R.tripFacts({ legs: [leg("imoova-9", 20)], totalDays: 3 }, { stations: withLisbon, routes: r, costs });
  assert.deepEqual(there.countries, ["ES", "PT"]);
  assert.deepEqual(back.countries, ["PT", "ES"]);
  assert.equal(back.measured, true);
});

test("a leg with a listed price costs that price instead of the rally fee and insurance", () => {
  const t = madridHome();
  const priced = { ...t, legs: t.legs.map((r, i) => (i === 0 ? { ...r, price: 50 } : r)) };
  const priceEur = (r) => (typeof r.price === "number" ? r.price : null);
  const f = R.tripFacts(priced, { stations, routes, costs: { ...costs, priceEur } });
  // 50 listed + (129 fee + 7 days × 15) for the other leg + diesel for both
  assert.equal(f.cost.toFixed(2), (50 + 129 + 105 + 4620 * 0.1 * 1.8).toFixed(2));
});

test("ranks by departure dates, backups and round trips", () => {
  const byTrips = rank("trips");
  assert.equal(byTrips[0].name, "Madrid");
  assert.equal(byTrips[0].values.trips, 2);
  assert.equal(byTrips[0].values.dates, 1); // both Madrid trips leave on the same day
  assert.equal(byTrips[0].values.backups, 2); // two ways back after that one outbound rally
  assert.equal(rank("backups")[0].name, "Madrid");
});

test("ranks by stay, distance and pace", () => {
  assert.equal(rank("stay")[0].name, "Madrid"); // 2 days before the Marburg rally
  assert.deepEqual(names(rank("distance")), ["Madrid", "Barcelona", "Antwerp"]);
  assert.equal(rank("pace")[0].name, "Antwerp"); // 750 km over 7 days is the gentlest
});

test("ranks by weather in the month you arrive", () => {
  assert.deepEqual(names(rank("warmth")), ["Madrid", "Barcelona", "Antwerp"]);
  assert.deepEqual(names(rank("dry")), ["Madrid", "Barcelona", "Antwerp"]);
  assert.equal(rank("sun")[0].name, "Barcelona");
});

test("ranks by cost and keeps the cheapest trip for explanation", () => {
  const rows = rank("cost");
  assert.equal(rows[0].name, "Antwerp");
  assert.equal(rows[0].best.cost.legs[0].to, 47);
});

test("counts trips with rallies that are new since tracking", () => {
  const rows = rank("fresh");
  assert.equal(rows[0].name, "Madrid");
  assert.equal(rows[0].values.fresh, 1);
  assert.equal(rank("fresh", { freshSince: null })[0].values.fresh, null);
});

test("starting stations are ranked by the trips that begin there", () => {
  const rows = rank("trips", { mode: "starts" });
  assert.deepEqual(rows.map((r) => [r.name, r.trips]), [["Berlin-Schönefeld", 3], ["Berlin", 1]]);
  assert.equal(rows[0].values.stay, null); // only meaningful for destinations
});

test("combined ranking averages percentiles and shows the parts", () => {
  const rows = rank("combined", { combine: ["warmth", "trips"] });
  assert.equal(rows[0].name, "Madrid");
  assert.deepEqual(rows[0].parts, { warmth: 1, trips: 1 });
  assert.equal(rows[2].name, "Antwerp");
});

test("ties share the better percentile", () => {
  const rows = [{ id: 1, values: { trips: 3 } }, { id: 2, values: { trips: 3 } }, { id: 3, values: { trips: 1 } }];
  const p = R.percentiles(rows, "trips");
  assert.equal(p.get(1), 1);
  assert.equal(p.get(2), 1);
  assert.equal(p.get(3), 0);
});

test("new this week never counts the rallies found on the first tracked day", () => {
  assert.equal(R.freshSince("2026-11-05T07:00:00Z", "2026-11-03"), "2026-11-04");
  assert.equal(R.freshSince("2026-11-20T07:00:00Z", "2026-11-03"), "2026-11-13");
  assert.equal(R.freshSince("2026-11-20T07:00:00Z", undefined), null);
  assert.equal(R.freshSince("2026-11-03T07:00:00Z", "2026-11-03"), null); // nothing can be new on day one
});

// ---------- One-way trips ----------

// The same rallies as one-way trips: to Madrid (and on to Marburg), to Barcelona (and on to Hamburg),
// to Antwerp. The rallies back to Berlin end in the start area, so they extend nothing.
const oneWayTrips = M.findTrips(
  { stations: stationList, rallies },
  {
    tripType: "oneway",
    home: { lat: 52.52, lon: 13.405 },
    startRadiusKm: 50,
    hopRadiusKm: 0,
    earliest: "2026-11-01",
    latest: "2026-12-31",
    maxWaitDays: 2,
    maxLegs: 2,
    sort: "start",
  }
);

function rankOneWay(by, extra = {}) {
  const ctx = { stations, routes, costs, facts: new Map() };
  for (const t of oneWayTrips) ctx.facts.set(t.id, R.tripFacts(t, ctx));
  return R.rankStations(oneWayTrips, ctx, {
    mode: "destinations",
    tripType: "oneway",
    by,
    home: stations.get(6),
    today: "2026-11-01",
    freshSince: "2026-11-04",
    climate,
    ...extra,
  });
}

test("a one-way trip takes you to where it ends, a round trip only to its stops", () => {
  assert.equal(oneWayTrips.length, 5);
  const toMadrid = oneWayTrips.find((t) => t.legs.length === 1 && t.legs[0].to === 20);
  const onToMarburg = oneWayTrips.find((t) => t.legs.length === 2 && t.legs[1].to === 22);
  assert.deepEqual([...R.stopsOf(toMadrid)], [20]);
  assert.deepEqual([...R.stopsOf(onToMarburg)], [20, 22]);
  assert.deepEqual([...R.stopsOf(madridHome())], [20]);
});

test("one-way destinations include the places trips end at", () => {
  const rows = rankOneWay("trips");
  assert.deepEqual(
    rows.map((r) => [r.name, r.trips]),
    [["Barcelona", 2], ["Madrid", 2], ["Antwerp", 1], ["Hamburg", 1], ["Marburg", 1]]
  );
  assert.equal(rankOneWay("distance")[0].name, "Madrid");
  assert.deepEqual(rankOneWay("trips", { mode: "starts" }).map((r) => [r.name, r.trips]), [["Berlin-Schönefeld", 4], ["Berlin", 1]]);
});

test("the weather at a one-way destination is for the month you arrive", () => {
  const rows = rankOneWay("warmth");
  assert.deepEqual(names(rows).slice(0, 3), ["Madrid", "Barcelona", "Antwerp"]);
  assert.equal(rows[2].arrivalMonth, 10); // Antwerp is only ever the end of a trip, reached on 14 Nov
  assert.equal(rows[3].rank, null); // no weather data for Hamburg and Marburg
});

test("backups and stay are figures for round trips only", () => {
  assert.equal(R.metricApplies("stay", "destinations", "round"), true);
  assert.equal(R.metricApplies("stay", "destinations", "oneway"), false);
  assert.equal(R.metricApplies("stay", "starts", "round"), false);
  assert.equal(R.metricApplies("backups", "starts", "oneway"), false);
  assert.equal(R.metricApplies("dates", "starts", "oneway"), true);
  assert.equal(R.metricApplies("nonsense", "starts", "oneway"), false);

  const rows = rankOneWay("trips");
  assert.ok(rows.every((r) => r.values.stay === null && r.values.backups === null));
  assert.ok(rankOneWay("stay").every((r) => r.rank === null));
  const combined = rankOneWay("combined", { combine: ["stay", "backups", "trips"] });
  assert.deepEqual(Object.keys(combined[0].parts), ["trips"]);
  assert.ok(rank("trips").every((r) => r.values.stay !== null && r.values.backups !== null)); // still there for round trips
});

test("a one-way trip costs one rally, and its facts cover a single leg", () => {
  const toMadrid = oneWayTrips.find((t) => t.legs.length === 1 && t.legs[0].to === 20);
  const f = R.tripFacts(toMadrid, { stations, routes, costs });
  // 129 fee + 7 days × 15 insurance + 2300 km × 10 l/100 km × 1.80 €/l
  assert.equal(f.cost.toFixed(2), (129 + 105 + 2300 * 0.1 * 1.8).toFixed(2));
  assert.equal(f.legs.length, 1);
  assert.deepEqual(f.countries, ["DE", "FR", "ES"]);
  assert.equal(f.costPerDay.toFixed(2), (f.cost / 7).toFixed(2));
});
