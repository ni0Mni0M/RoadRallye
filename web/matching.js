// Round-trip matching for one-way rallies (roadsurfer, Imoova).
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

  function haversineKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  }

  // Dates are "YYYY-MM-DD" strings; compare them as UTC days so DST never shifts a day.
  function toDay(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / DAY_MS;
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
  };

  /**
   * Find round trips made of two or three rallies: the first starts near home, every leg
   * but the last ends outside the return area, and the last one ends inside it.
   * Between legs you may wait, and optionally take a train to a nearby station.
   *
   * opts:
   *   home            {lat, lon}
   *   startRadiusKm   first rally must start this close to home
   *   returnRadiusKm  last rally must end this close to home
   *   hopRadiusKm     a rally may start this far from where the previous one ended (0 = same station,
   *                   or another provider's station within SAME_PLACE_KM)
   *   earliest        first allowed pickup date ("YYYY-MM-DD")
   *   latest          last allowed return date ("YYYY-MM-DD")
   *   maxWaitDays     days allowed between one drop-off and the next pickup
   *   maxLegs         2 or 3 rallies per trip (default 2)
   *   sort            "start" | "days" | "wait" | "distance"
   *
   * Each trip: { id, legs, waits, hops, waitDays, totalDays, startKm, endKm }
   *   legs   the rallies in order
   *   waits  days between consecutive legs (one entry per gap)
   *   hops   km by train between consecutive legs (0 = same station)
   */
  function findRoundTrips(data, opts) {
    const maxLegs = opts.maxLegs === 3 ? 3 : 2;

    const stations = new Map();
    for (const s of data.stations) {
      if (typeof s.lat === "number" && typeof s.lon === "number") stations.set(s.id, s);
    }
    const homeKm = new Map();
    for (const s of stations.values()) homeKm.set(s.id, haversineKm(opts.home, s));

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
          const km = startId === id ? 0 : haversineKm(here, there);
          const samePlace = km <= SAME_PLACE_KM && (here.provider || "") !== (there.provider || "");
          if (km <= opts.hopRadiusKm || samePlace) list.push({ id: startId, km });
        }
        hopCache.set(id, list);
      }
      return hopCache.get(id);
    }

    const trips = [];

    function extend(legs, waits, hops) {
      const last = legs[legs.length - 1];
      for (const hop of hopStations(last.to)) {
        for (const next of byStart.get(hop.id)) {
          const wait = daysBetween(last.return, next.pickup);
          if (wait < 0 || wait > opts.maxWaitDays) continue;
          if (next.return > opts.latest) continue;
          const nextLegs = [...legs, next];
          const nextWaits = [...waits, wait];
          const nextHops = [...hops, hop.km];
          if (homeKm.get(next.to) <= opts.returnRadiusKm) {
            trips.push({
              id: nextLegs.map((r) => `${r.from}-${r.to}-${r.pickup}-${r.return}`).join("_"),
              legs: nextLegs,
              waits: nextWaits,
              hops: nextHops,
              waitDays: nextWaits.reduce((sum, w) => sum + w, 0),
              totalDays: daysBetween(nextLegs[0].pickup, next.return),
              startKm: homeKm.get(nextLegs[0].from),
              endKm: homeKm.get(next.to),
            });
          } else if (nextLegs.length < maxLegs) {
            extend(nextLegs, nextWaits, nextHops);
          }
        }
      }
    }

    for (const [startId, outs] of byStart) {
      if (homeKm.get(startId) > opts.startRadiusKm) continue;
      for (const out of outs) {
        if (out.pickup < opts.earliest || out.return > opts.latest) continue;
        // A rally that already ends inside the return area is a one-way trip home, not a round trip.
        if (homeKm.get(out.to) <= opts.returnRadiusKm) continue;
        extend([out], [], []);
      }
    }

    trips.sort(SORTERS[opts.sort] || SORTERS.start);
    return trips;
  }

  return { SAME_PLACE_KM, haversineKm, daysBetween, addDays, findRoundTrips };
});
