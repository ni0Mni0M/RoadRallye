// Trip matching for one-way rallies (roadsurfer, Imoova): one-way trips and round trips.
// Works as a plain <script> in the browser (window.RallyMatching) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RallyMatching = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EARTH_RADIUS_KM = 6371;
  const DAY_MS = 86400000;
  // Stations of different providers this close together count as one place, even with train hops off:
  // Imoova only gives city centres, up to ~30 km from the roadsurfer station in the same city (Milan, Dallas).
  const SAME_PLACE_KM = 30;
  // One rental company's station listed by two sources, a few hundred metres apart, is one station:
  // roadsurfer's Marburg, and the Marburg that Movacar lists for roadsurfer's vans.
  const SAME_STATION_KM = 1;

  function haversineKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  }

  /**
   * The stations that are listed twice: station id -> Set of the ids of its other entries.
   * Two entries are one station when they lie within SAME_STATION_KM of each other and belong to
   * the same rental company. A station's companies are whoever supplies the vans of its rallies
   * (Movacar and Imoova name the supplier, roadsurfer's own rallies are roadsurfer's), so another
   * company's station next door stays a separate one. A station without rallies goes by its source.
   */
  function stationTwins(data) {
    const located = data.stations.filter((s) => typeof s.lat === "number" && typeof s.lon === "number");
    const sourceOf = new Map(located.map((s) => [s.id, s.provider || "roadsurfer"]));
    const companies = new Map(located.map((s) => [s.id, new Set()]));
    for (const r of data.rallies) {
      const from = companies.get(r.from);
      const to = companies.get(r.to);
      if (!from || !to) continue;
      const company = r.supplier || sourceOf.get(r.from);
      from.add(company);
      to.add(company);
    }
    for (const [id, set] of companies) {
      if (!set.size) set.add(sourceOf.get(id));
    }
    const twins = new Map();
    const link = (a, b) => {
      if (!twins.has(a)) twins.set(a, new Set());
      twins.get(a).add(b);
    };
    const maxLatDiff = SAME_STATION_KM / 111; // one degree of latitude is ~111 km: skips most pairs cheaply
    for (let i = 0; i < located.length; i++) {
      for (let j = i + 1; j < located.length; j++) {
        const a = located[i];
        const b = located[j];
        if (Math.abs(a.lat - b.lat) > maxLatDiff || haversineKm(a, b) > SAME_STATION_KM) continue;
        const shared = [...companies.get(a.id)].some((c) => companies.get(b.id).has(c));
        if (shared) {
          link(a.id, b.id);
          link(b.id, a.id);
        }
      }
    }
    return twins;
  }

  // Dates are "YYYY-MM-DD" strings; compare them as UTC days so DST never shifts a day.
  // The search compares the same few hundred dates over and over, so each is worked out only once.
  const dayNumbers = new Map();
  function toDay(iso) {
    let day = dayNumbers.get(iso);
    if (day === undefined) {
      const [y, m, d] = iso.split("-").map(Number);
      day = Date.UTC(y, m - 1, d) / DAY_MS;
      dayNumbers.set(iso, day);
    }
    return day;
  }

  function daysBetween(fromIso, toIso) {
    return toDay(toIso) - toDay(fromIso);
  }

  function addDays(iso, n) {
    return new Date((toDay(iso) + n) * DAY_MS).toISOString().slice(0, 10);
  }

  const first = (t) => t.legs[0];
  const SORTERS = {
    start: (a, b) => first(a).pickup.localeCompare(first(b).pickup) || a.totalDays - b.totalDays,
    days: (a, b) => a.totalDays - b.totalDays || first(a).pickup.localeCompare(first(b).pickup),
    wait: (a, b) => a.waitDays - b.waitDays || first(a).pickup.localeCompare(first(b).pickup),
    distance: (a, b) => a.endKm - b.endKm || first(a).pickup.localeCompare(first(b).pickup),
    far: (a, b) => b.endKm - a.endKm || first(a).pickup.localeCompare(first(b).pickup),
  };

  /**
   * Find trips made of rallies chained together. The first rally always starts near home.
   *
   * Round trips (tripType "round", the default) take two or three rallies: every leg but the last
   * ends outside the return area, and the last one ends inside it.
   * One-way trips (tripType "oneway") take one to three rallies and end wherever the last one does.
   * Each of their rallies ends outside the start area and away from every place the trip has
   * already been, so a chain never loops back.
   * Between legs you may wait, and optionally take a train to a nearby station.
   *
   * opts:
   *   tripType        "round" (default) | "oneway"
   *   home            {lat, lon}
   *   startRadiusKm   first rally must start this close to home
   *   returnRadiusKm  round trips only: last rally must end this close to home
   *   hopRadiusKm     a rally may start this far from where the previous one ended (0 = same station,
   *                   or another provider's station within SAME_PLACE_KM)
   *                   A station listed twice (stationTwins) counts as one station for all three.
   *   earliest        first allowed pickup date ("YYYY-MM-DD")
   *   latest          last allowed return date ("YYYY-MM-DD")
   *   maxWaitDays     days allowed between one drop-off and the next pickup
   *   maxLegs         most rallies per trip: 2 or 3 for round trips (default 2), 1 to 3 for one-way
   *                   trips (default 1). Shorter trips are listed too.
   *   sort            "start" | "days" | "wait" | "distance" (ends closest to home first) |
   *                   "far" (ends farthest from home first)
   *
   * Each trip: { id, type, legs, waits, hops, waitDays, totalDays, startKm, endKm }
   *   type   "round" | "oneway"
   *   legs   the rallies in order
   *   waits  days between consecutive legs (one entry per gap)
   *   hops   km by train between consecutive legs (0 = same station)
   */
  function findTrips(data, opts) {
    const oneWay = opts.tripType === "oneway";
    const maxLegs = oneWay ? ([2, 3].includes(opts.maxLegs) ? opts.maxLegs : 1) : opts.maxLegs === 3 ? 3 : 2;

    const stations = new Map();
    for (const s of data.stations) {
      if (typeof s.lat === "number" && typeof s.lon === "number") stations.set(s.id, s);
    }
    const homeKm = new Map();
    for (const s of stations.values()) homeKm.set(s.id, haversineKm(opts.home, s));
    // A station listed twice is as far from home as its nearest entry: "home only" covers both.
    const twins = stationTwins(data);
    const sameStation = (a, b) => a === b || (twins.has(a) && twins.get(a).has(b));
    for (const [id, others] of twins) {
      homeKm.set(id, Math.min(haversineKm(opts.home, stations.get(id)), ...[...others].map((o) => haversineKm(opts.home, stations.get(o)))));
    }

    const byStart = new Map();
    for (const r of data.rallies) {
      if (!stations.has(r.from) || !stations.has(r.to)) continue;
      if (!byStart.has(r.from)) byStart.set(r.from, []);
      byStart.get(r.from).push(r);
    }

    // Stations the next leg may start from, per drop-off station (computed lazily).
    const hopCache = new Map();
    function hopStations(id) {
      if (!hopCache.has(id)) {
        const here = stations.get(id);
        const list = [];
        for (const startId of byStart.keys()) {
          const there = stations.get(startId);
          const km = sameStation(startId, id) ? 0 : haversineKm(here, there);
          const samePlace = km <= SAME_PLACE_KM && (here.provider || "") !== (there.provider || "");
          if (km <= opts.hopRadiusKm || samePlace) list.push({ id: startId, km });
        }
        hopCache.set(id, list);
      }
      return hopCache.get(id);
    }

    const trips = [];

    function addTrip(legs, waits, hops) {
      const last = legs[legs.length - 1];
      trips.push({
        id: legs.map((r) => `${r.from}-${r.to}-${r.pickup}-${r.return}`).join("_"),
        type: oneWay ? "oneway" : "round",
        legs,
        waits,
        hops,
        waitDays: waits.reduce((sum, w) => sum + w, 0),
        totalDays: daysBetween(legs[0].pickup, last.return),
        startKm: homeKm.get(legs[0].from),
        endKm: homeKm.get(last.to),
      });
    }

    // Calls visit(rally, days waited, km hopped by train) for every rally that can follow the last leg.
    function eachNext(legs, visit) {
      const last = legs[legs.length - 1];
      for (const hop of hopStations(last.to)) {
        for (const next of byStart.get(hop.id)) {
          const wait = daysBetween(last.return, next.pickup);
          if (wait < 0 || wait > opts.maxWaitDays) continue;
          if (next.return > opts.latest) continue;
          visit(next, wait, hop.km);
        }
      }
    }

    function extendRound(legs, waits, hops) {
      eachNext(legs, (next, wait, km) => {
        const nextLegs = [...legs, next];
        if (homeKm.get(next.to) <= opts.returnRadiusKm) addTrip(nextLegs, [...waits, wait], [...hops, km]);
        else if (nextLegs.length < maxLegs) extendRound(nextLegs, [...waits, wait], [...hops, km]);
      });
    }

    // One-way trips keep moving: a rally only counts when it ends outside the start area and away
    // from every place the trip has been, its own pickup station included.
    const startAreaKm = Math.max(opts.startRadiusKm, SAME_PLACE_KM);
    const apart = (a, b) => a !== b && haversineKm(stations.get(a), stations.get(b)) > SAME_PLACE_KM;
    function goesSomewhereNew(legs, next) {
      if (homeKm.get(next.to) <= startAreaKm || !apart(next.from, next.to)) return false;
      return legs.every((r) => apart(r.from, next.to) && apart(r.to, next.to));
    }

    function extendOneWay(legs, waits, hops) {
      addTrip(legs, waits, hops);
      if (legs.length >= maxLegs) return;
      eachNext(legs, (next, wait, km) => {
        if (goesSomewhereNew(legs, next)) extendOneWay([...legs, next], [...waits, wait], [...hops, km]);
      });
    }

    for (const [startId, outs] of byStart) {
      if (homeKm.get(startId) > opts.startRadiusKm) continue;
      for (const out of outs) {
        if (out.pickup < opts.earliest || out.return > opts.latest) continue;
        if (oneWay) {
          if (goesSomewhereNew([], out)) extendOneWay([out], [], []);
        } else if (homeKm.get(out.to) > opts.returnRadiusKm) {
          // A rally that already ends inside the return area is a one-way trip home, not a round trip.
          extendRound([out], [], []);
        }
      }
    }

    trips.sort(SORTERS[opts.sort] || SORTERS.start);
    return trips;
  }

  const findRoundTrips = (data, opts) => findTrips(data, { ...opts, tripType: "round" });

  return { SAME_PLACE_KM, SAME_STATION_KM, haversineKm, stationTwins, daysBetween, addDays, findTrips, findRoundTrips };
});
