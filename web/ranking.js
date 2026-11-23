// Station ranking: per-station figures from the trips that matching.js finds.
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
  // types: the kinds of trip it says something about (both when left out). A stay is the time
  // between two rallies, so it doesn't fit one-way trips.
  const METRICS = {
    trips: { label: "Most trips", better: "high", modes: ["destinations", "starts"] },
    stay: { label: "Longest stay", better: "high", modes: ["destinations"], types: ["round"] },
    pace: { label: "Most relaxed pace", better: "low", modes: ["destinations", "starts"] },
    distance: { label: "Farthest from home", better: "high", modes: ["destinations"] },
    countries: { label: "Most countries", better: "high", modes: ["destinations", "starts"] },
    weather: { label: "Best weather", better: "high", modes: ["destinations"], needs: "climate" },
    scenic: { label: "Most scenic route", better: "high", modes: ["destinations", "starts"], needs: "routes" },
    cost: { label: "Cheapest trip", better: "low", modes: ["destinations", "starts"] },
    fresh: { label: "New this week", better: "high", modes: ["destinations", "starts"], needs: "tracking" },
    soonest: { label: "Departing soonest", better: "low", modes: ["destinations", "starts"] },
  };

  // Best weather is one figure made of three: how a station does on each of them among the listed
  // stations (percentiles), averaged. The three stay in a row's values, to show what it is made of.
  const WEATHER_PARTS = { warmth: "high", sun: "high", dry: "low" };

  // Route info is stored once per station pair, lower id first: roadsurfer's numbers in numeric order,
  // then Imoova's text ids ("imoova-12"). fetch_route_info.py orders them the same way.
  const idBefore = (a, b) => (typeof a === typeof b ? a < b : typeof a === "number");
  const routeKey = (a, b) => (idBefore(a, b) ? `${a}-${b}` : `${b}-${a}`);

  // Whether a metric says anything in this list ("destinations" | "starts") for this kind of trip.
  function metricApplies(key, mode, tripType = "round") {
    const m = METRICS[key];
    return Boolean(m) && m.modes.includes(mode) && (!m.types || m.types.includes(tripType));
  }

  // Stations a trip takes you to: where it stops between rallies (drop-off and, after a train hop,
  // the next pickup) and, for a one-way trip, where it ends. A round trip ends back home.
  function stopsOf(t) {
    const stops = new Set();
    for (let i = 0; i < t.legs.length - 1; i++) {
      stops.add(t.legs[i].to);
      stops.add(t.legs[i + 1].from);
    }
    if (t.type === "oneway") stops.add(t.legs[t.legs.length - 1].to);
    return stops;
  }

  // How many one-way fees the same trip would cost as normal rentals. None when it ends at the
  // station it started from (one return rental). Otherwise one for each stretch of rallies driven
  // back to back: you would keep the same van until a wait or a train hop makes you hand it back.
  function oneWayFees(legs) {
    if (legs[legs.length - 1].to === legs[0].from) return 0;
    let fees = 1;
    for (let i = 1; i < legs.length; i++) {
      if (legs[i].from !== legs[i - 1].to || legs[i].pickup > legs[i - 1].return) fees += 1;
    }
    return fees;
  }

  /**
   * Facts about one trip that need more than the rally list.
   * ctx: { stations: Map, routes: { "a-b": info } | null,
   *        costs: { rallyFee, insurancePerDay, vanLitresPer100Km, fuelPrice, priceEur,
   *                 normalDayPrice, oneWayFee } }
   * priceEur(leg) is the leg's listed price in euros (Imoova), or null to use roadsurfer's rally fee
   * and insurance instead.
   * cost = rent + fuel. normalRent is a rough guess at the same rallies as ordinary one-way rentals
   * (a flat price per day plus `oneWayFees` one-way fees, with the same insurance), or null when
   * those two aren't given;
   * saving is how much less the rally rent is. costParts is what the rent is made of.
   * Besides the totals it returns `legs` (what each rally drives through, for "Along the way") and
   * `sites` (the parks and World Heritage sites with a position, for the map).
   */
  function tripFacts(t, ctx) {
    let roadKm = 0;
    let rallyDays = 0;
    let rent = 0;
    let fuel = 0;
    const fees = oneWayFees(t.legs);
    let normalRent = fees * ctx.costs.oneWayFee;
    // feeLegs/feeDays: rallies paid with the rally fee and insurance; listed: those with a listed price.
    const costParts = { feeLegs: 0, feeDays: 0, listedLegs: 0, listedRent: 0 };
    const hasNormal = typeof ctx.costs.normalDayPrice === "number" && typeof ctx.costs.oneWayFee === "number";
    let coastKm = 0;
    let mountainKm = 0;
    let measured = true;
    const countries = [];
    const parks = new Map();
    const unesco = new Map();
    const sites = new Map(); // id -> { kind, id, name, lat, lon }
    const legs = [];
    const addCountry = (code) => {
      if (code && !countries.includes(code)) countries.push(code);
    };
    const addSites = (kind, list) => {
      for (const [id, name, lat, lon] of list) {
        if (typeof lat === "number" && typeof lon === "number" && !sites.has(id)) sites.set(id, { kind, id, name, lat, lon });
      }
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
      // Insurance is extra cover you can add to a roadsurfer rally (0 a day when left out).
      const insurance = listed === null ? ctx.costs.insurancePerDay * days : 0;
      if (listed !== null) {
        costParts.listedLegs += 1;
        costParts.listedRent += listed;
        rent += listed;
      } else {
        costParts.feeLegs += 1;
        costParts.feeDays += days;
        rent += ctx.costs.rallyFee + insurance;
      }
      fuel += ((km * ctx.costs.vanLitresPer100Km) / 100) * ctx.costs.fuelPrice;
      // The same cover would cost the same on a normal rental, so it never changes the saving.
      if (hasNormal) normalRent += ctx.costs.normalDayPrice * days + insurance;
      // Route info is stored in the direction from the lower to the higher id.
      const legCountries = info ? (idBefore(leg.from, leg.to) ? info.countries : [...info.countries].reverse()) : [];
      if (info) {
        legCountries.forEach(addCountry);
        for (const [id, name] of info.parks) parks.set(id, name);
        for (const [id, name] of info.unesco) unesco.set(id, name);
        addSites("park", info.parks);
        addSites("unesco", info.unesco);
        coastKm += info.coastKm;
        mountainKm += info.mountainKm;
      } else {
        measured = false;
      }
      addCountry(b.country);
      legs.push({
        from: leg.from,
        to: leg.to,
        km,
        measured: Boolean(info),
        drivingMin: info && typeof info.min === "number" ? info.min : null,
        countries: info ? legCountries : [a.country, b.country].filter((c, i, all) => c && all.indexOf(c) === i),
        parks: info ? info.parks.map((p) => p[1]) : [],
        unesco: info ? info.unesco.map((p) => p[1]) : [],
        coastKm: info ? info.coastKm : null,
        mountainKm: info ? info.mountainKm : null,
        maxElevation: info && typeof info.maxElevation === "number" ? info.maxElevation : null,
      });
    }
    const drivingMin = legs.every((l) => l.drivingMin !== null) ? legs.reduce((s, l) => s + l.drivingMin, 0) : null;
    const cost = rent + fuel;

    return {
      roadKm,
      rallyDays,
      kmPerDay: roadKm / Math.max(1, rallyDays),
      drivingMin,
      drivingMinPerDay: drivingMin === null ? null : drivingMin / Math.max(1, rallyDays),
      legs,
      sites: [...sites.values()],
      cost,
      rent,
      fuel,
      costParts,
      oneWayFees: fees,
      normalRent: hasNormal ? normalRent : null,
      saving: hasNormal ? normalRent - rent : null,
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
    const applies = (key) => metricApplies(key, opts.mode, opts.tripType);
    const dates = [...new Set(list.map((t) => t.legs[0].pickup))].sort();

    // Days spent here between rallies, and the month you arrive (for the weather).
    let stay = 0;
    const arrivals = [];
    for (const t of list) {
      for (let i = 0; i < t.legs.length - 1; i++) {
        if (t.legs[i].to === id || t.legs[i + 1].from === id) stay = Math.max(stay, t.waits[i]);
        if (t.legs[i].to === id) arrivals.push(t.legs[i].return);
      }
      // A one-way trip also arrives where it ends.
      const end = t.legs[t.legs.length - 1];
      if (t.type === "oneway" && end.to === id) arrivals.push(end.return);
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
        trips: list.length,
        stay: applies("stay") ? stay : null,
        pace: facts(relaxedTrip).kmPerDay,
        distance: opts.mode === "destinations" ? M.haversineKm(opts.home, station) : null,
        countries: facts(countryTrip).countries.length,
        warmth: opts.mode === "destinations" ? weather("t") : null,
        sun: opts.mode === "destinations" ? weather("sun") : null,
        dry: opts.mode === "destinations" ? weather("rain") : null,
        scenic: scenicTrip ? facts(scenicTrip).scenic : null,
        cost: facts(cheapTrip).cost,
        fresh: tracking ? list.filter((t) => t.legs.some((r) => r.first_seen && r.first_seen >= opts.freshSince)).length : null,
        soonest: M.daysBetween(opts.today, dates[0]),
      },
      best: { scenic: scenicTrip, countries: countryTrip, cost: cheapTrip, pace: relaxedTrip },
      arrivalMonth: months.length ? months.sort((a, b) => a - b)[Math.floor(months.length / 2)] : null,
    };
  }

  // 1 for the best station on a metric, 0 for the worst; null when the metric has no value.
  function percentiles(rows, key, better = METRICS[key].better) {
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
   * opts: { mode: "destinations" | "starts", tripType: "round" (default) | "oneway",
   *         by: metric key | "combined", combine: [keys], home, today, freshSince, climate }
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

    const weatherTables = Object.entries(WEATHER_PARTS).map(([key, better]) => percentiles(rows, key, better));
    for (const r of rows) {
      const parts = weatherTables.filter((table) => table.has(r.id)).map((table) => table.get(r.id));
      r.values.weather = mean(parts);
    }

    let score;
    if (opts.by === "combined") {
      const keys = (opts.combine || []).filter((k) => metricApplies(k, opts.mode, opts.tripType));
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

  // Typical weather at a station in the month of a date: { month 0-11, t, rain, sun }, or null without data.
  function weatherFor(climate, id, iso) {
    const months = climate && climate.stations[String(id)];
    if (!months) return null;
    const month = Number(iso.slice(5, 7)) - 1;
    return { month, ...months[month] };
  }

  // First day whose newly seen rallies count as new, or null while nothing can be new yet.
  function freshSince(fetchedAt, trackingSince) {
    if (!trackingSince || fetchedAt.slice(0, 10) <= trackingSince) return null;
    const since = M.addDays(fetchedAt.slice(0, 10), -FRESH_DAYS);
    // Rallies seen on the first tracked day were already there, so they never count as new.
    return since > trackingSince ? since : M.addDays(trackingSince, 1);
  }

  return {
    METRICS, SCENIC_WEIGHTS, FRESH_DAYS, routeKey, metricApplies, stopsOf, oneWayFees, tripFacts, rankStations, percentiles,
    freshSince, weatherFor,
  };
});
