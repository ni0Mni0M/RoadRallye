// Station ranking: per-station figures from the round trips that matching.js finds.
// Works as a plain <script> in the browser (window.RallyRanking) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./matching.js"));
  else root.RallyRanking = factory(root.RallyMatching);
})(typeof self !== "undefined" ? self : this, function (M) {
  "use strict";

  const ROAD_FACTOR = 1.25; // road km per straight-line km, when a route's real length isn't known
  const FRESH_DAYS = 7;

  // What makes a route scenic, and how much each thing counts. Always shown with its parts.
  const SCENIC_WEIGHTS = { park: 3, unesco: 2, coastKm: 1 / 20, mountainKm: 1 / 20 };

  // better: which end of the scale wins. modes: which list it applies to. needs: extra data.
  const METRICS = {
    dates: { group: "Opportunities", label: "Most departure dates", better: "high", modes: ["destinations", "starts"] },
    backups: { group: "Opportunities", label: "Most backup options", better: "high", modes: ["destinations", "starts"] },
    trips: { group: "Opportunities", label: "Most round trips", better: "high", modes: ["destinations", "starts"] },
    stay: { group: "Time there", label: "Longest stay", better: "high", modes: ["destinations"] },
    pace: { group: "Pace", label: "Most relaxed pace", better: "low", modes: ["destinations", "starts"] },
    distance: { group: "Adventure", label: "Farthest from home", better: "high", modes: ["destinations"] },
    countries: { group: "Adventure", label: "Most countries", better: "high", modes: ["destinations", "starts"] },
    warmth: { group: "Season", label: "Warmest", better: "high", modes: ["destinations"], needs: "climate" },
    sun: { group: "Season", label: "Sunniest", better: "high", modes: ["destinations"], needs: "climate" },
    dry: { group: "Season", label: "Fewest rainy days", better: "low", modes: ["destinations"], needs: "climate" },
    scenic: { group: "Scenery", label: "Most scenic route", better: "high", modes: ["destinations", "starts"], needs: "routes" },
    cost: { group: "Cost", label: "Cheapest trip", better: "low", modes: ["destinations", "starts"] },
    costPerDay: { group: "Cost", label: "Cheapest per day", better: "low", modes: ["destinations", "starts"] },
    fresh: { group: "Freshness", label: "New this week", better: "high", modes: ["destinations", "starts"], needs: "tracking" },
    soonest: { group: "Freshness", label: "Departing soonest", better: "low", modes: ["destinations", "starts"] },
  };

  // Route info is stored once per station pair, lower id first: roadsurfer's numbers in numeric order,
  // then Imoova's text ids ("imoova-12"). fetch_route_info.py orders them the same way.
  const idBefore = (a, b) => (typeof a === typeof b ? a < b : typeof a === "number");
  const routeKey = (a, b) => (idBefore(a, b) ? `${a}-${b}` : `${b}-${a}`);
  const legKey = (r) => `${r.from}-${r.to}-${r.pickup}`;

  // Stations a trip stops at between rallies (drop-off and, after a train hop, the next pickup).
  function stopsOf(t) {
    const stops = new Set();
    for (let i = 0; i < t.legs.length - 1; i++) {
      stops.add(t.legs[i].to);
      stops.add(t.legs[i + 1].from);
    }
    return stops;
  }

  /**
   * Facts about one trip that need more than the rally list.
   * ctx: { stations: Map, routes: { "a-b": info } | null,
   *        costs: { rallyFee, insurancePerDay, vanLitresPer100Km, fuelPrice, priceEur } }
   * priceEur(leg) is the leg's listed price in euros (Imoova), or null to use roadsurfer's rally fee
   * and insurance instead.
   */
  function tripFacts(t, ctx) {
    let roadKm = 0;
    let rallyDays = 0;
    let cost = 0;
    let coastKm = 0;
    let mountainKm = 0;
    let measured = true;
    const countries = [];
    const parks = new Map();
    const unesco = new Map();
    const addCountry = (code) => {
      if (code && !countries.includes(code)) countries.push(code);
    };

    addCountry(ctx.stations.get(t.legs[0].from).country);
    for (const leg of t.legs) {
      const a = ctx.stations.get(leg.from);
      const b = ctx.stations.get(leg.to);
      const info = ctx.routes ? ctx.routes[routeKey(leg.from, leg.to)] : null;
      const km = info ? info.km : M.haversineKm(a, b) * ROAD_FACTOR;
      const days = M.daysBetween(leg.pickup, leg.return);
      roadKm += km;
      rallyDays += days;
      const listed = ctx.costs.priceEur ? ctx.costs.priceEur(leg) : null;
      const rental = listed !== null ? listed : ctx.costs.rallyFee + ctx.costs.insurancePerDay * days;
      cost += rental + ((km * ctx.costs.vanLitresPer100Km) / 100) * ctx.costs.fuelPrice;
      if (info) {
        // Route info is stored in the direction from the lower to the higher id.
        (idBefore(leg.from, leg.to) ? info.countries : [...info.countries].reverse()).forEach(addCountry);
        for (const [id, name] of info.parks) parks.set(id, name);
        for (const [id, name] of info.unesco) unesco.set(id, name);
        coastKm += info.coastKm;
        mountainKm += info.mountainKm;
      } else {
        measured = false;
      }
      addCountry(b.country);
    }

    return {
      roadKm,
      rallyDays,
      kmPerDay: roadKm / Math.max(1, rallyDays),
      cost,
      costPerDay: cost / Math.max(1, t.totalDays),
      countries,
      parks: [...parks.values()],
      unesco: [...unesco.values()],
      coastKm,
      mountainKm,
      scenic: measured
        ? parks.size * SCENIC_WEIGHTS.park + unesco.size * SCENIC_WEIGHTS.unesco +
          coastKm * SCENIC_WEIGHTS.coastKm + mountainKm * SCENIC_WEIGHTS.mountainKm
        : null,
      measured,
    };
  }

  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const minBy = (xs, f) => xs.reduce((best, x) => (best === null || f(x) < f(best) ? x : best), null);
  const maxBy = (xs, f) => xs.reduce((best, x) => (best === null || f(x) > f(best) ? x : best), null);

  // Figures for one station from the trips that pass through (or start at) it.
  function stationRow(id, list, ctx, opts) {
    const station = ctx.stations.get(id);
    const facts = (t) => ctx.facts.get(t.id);
    const dates = [...new Set(list.map((t) => t.legs[0].pickup))].sort();

    const byFirstLeg = new Map();
    for (const t of list) byFirstLeg.set(legKey(t.legs[0]), (byFirstLeg.get(legKey(t.legs[0])) || 0) + 1);

    // Days spent here between rallies, and the month you arrive (for the weather).
    let stay = 0;
    const arrivals = [];
    for (const t of list) {
      for (let i = 0; i < t.legs.length - 1; i++) {
        if (t.legs[i].to === id || t.legs[i + 1].from === id) stay = Math.max(stay, t.waits[i]);
        if (t.legs[i].to === id) arrivals.push(t.legs[i].return);
      }
    }
    const months = arrivals.map((d) => Number(d.slice(5, 7)) - 1);
    const climate = opts.climate && opts.climate.stations[String(id)];
    const weather = (key) => (climate && months.length ? mean(months.map((m) => climate[m][key]).filter((v) => v !== null)) : null);

    const scenicTrip = maxBy(list.filter((t) => facts(t).scenic !== null), (t) => facts(t).scenic);
    const countryTrip = maxBy(list, (t) => facts(t).countries.length);
    const cheapTrip = minBy(list, (t) => facts(t).cost);
    const relaxedTrip = minBy(list, (t) => facts(t).kmPerDay);
    const tracking = Boolean(opts.freshSince);

    return {
      id,
      name: station.name,
      country: station.country,
      trips: list.length,
      dateList: dates,
      values: {
        dates: dates.length,
        backups: Math.round(mean([...byFirstLeg.values()]) * 10) / 10,
        trips: list.length,
        stay: opts.mode === "destinations" ? stay : null,
        pace: facts(relaxedTrip).kmPerDay,
        distance: opts.mode === "destinations" ? M.haversineKm(opts.home, station) : null,
        countries: facts(countryTrip).countries.length,
        warmth: opts.mode === "destinations" ? weather("t") : null,
        sun: opts.mode === "destinations" ? weather("sun") : null,
        dry: opts.mode === "destinations" ? weather("rain") : null,
        scenic: scenicTrip ? facts(scenicTrip).scenic : null,
        cost: facts(cheapTrip).cost,
        costPerDay: Math.min(...list.map((t) => facts(t).costPerDay)),
        fresh: tracking ? list.filter((t) => t.legs.some((r) => r.first_seen && r.first_seen >= opts.freshSince)).length : null,
        soonest: M.daysBetween(opts.today, dates[0]),
      },
      best: { scenic: scenicTrip, countries: countryTrip, cost: cheapTrip, pace: relaxedTrip },
      arrivalMonth: months.length ? months.sort((a, b) => a - b)[Math.floor(months.length / 2)] : null,
    };
  }

  // 1 for the best station on a metric, 0 for the worst; null when the metric has no value.
  function percentiles(rows, key) {
    const better = METRICS[key].better;
    const valued = rows.filter((r) => r.values[key] !== null && r.values[key] !== undefined);
    const sorted = [...valued].sort((a, b) => (better === "high" ? b.values[key] - a.values[key] : a.values[key] - b.values[key]));
    const out = new Map();
    sorted.forEach((r, i) => {
      // Ties share the better position.
      const first = sorted.findIndex((s) => s.values[key] === r.values[key]);
      out.set(r.id, sorted.length === 1 ? 1 : 1 - first / (sorted.length - 1));
    });
    return out;
  }

  /**
   * Ranks stations by one metric, or by several combined.
   * opts: { mode: "destinations" | "starts", by: metric key | "combined", combine: [keys],
   *         home, today, freshSince, climate }
   * ctx:  { stations, facts: Map trip id -> tripFacts }
   * Returns rows best first, each with `rank`, `values` and, when combined, `parts` (key -> 0..1).
   */
  function rankStations(trips, ctx, opts) {
    const groups = new Map();
    for (const t of trips) {
      const ids = opts.mode === "starts" ? [t.legs[0].from] : [...stopsOf(t)];
      for (const id of ids) {
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(t);
      }
    }
    const rows = [...groups].map(([id, list]) => stationRow(id, list, ctx, opts));

    let score;
    if (opts.by === "combined") {
      const keys = (opts.combine || []).filter((k) => METRICS[k] && METRICS[k].modes.includes(opts.mode));
      const tables = keys.map((k) => [k, percentiles(rows, k)]);
      for (const r of rows) {
        r.parts = {};
        for (const [k, table] of tables) if (table.has(r.id)) r.parts[k] = table.get(r.id);
        const parts = Object.values(r.parts);
        r.values.combined = parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : null;
      }
      score = (r) => r.values.combined;
    } else {
      const better = METRICS[opts.by].better;
      score = (r) => (r.values[opts.by] === null ? null : better === "high" ? r.values[opts.by] : -r.values[opts.by]);
    }

    rows.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa === null || sb === null) return sa === null ? (sb === null ? 0 : 1) : -1;
      return sb - sa || b.trips - a.trips || a.name.localeCompare(b.name);
    });
    rows.forEach((r, i) => {
      r.rank = score(r) === null ? null : i + 1;
    });
    return rows;
  }

  // First day whose newly seen rallies count as new, or null while nothing can be new yet.
  function freshSince(fetchedAt, trackingSince) {
    if (!trackingSince || fetchedAt.slice(0, 10) <= trackingSince) return null;
    const since = M.addDays(fetchedAt.slice(0, 10), -FRESH_DAYS);
    // Rallies seen on the first tracked day were already there, so they never count as new.
    return since > trackingSince ? since : M.addDays(trackingSince, 1);
  }

  return { METRICS, SCENIC_WEIGHTS, FRESH_DAYS, routeKey, stopsOf, tripFacts, rankStations, percentiles, freshSince };
});
