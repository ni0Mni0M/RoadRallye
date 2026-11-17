// Estimates and links for getting from the last drop-off back home: train & bus, car.
// Works as a plain <script> in the browser (window.WayHome) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./matching.js"));
  else root.WayHome = factory(root.RallyMatching);
})(typeof self !== "undefined" ? self : this, function (M) {
  "use strict";

  /**
   * Where the way home ends: the city's central station when the home station has one in
   * `centers` (web/centers.js), because a rental depot is often far outside the city.
   */
  function homePoint(station, centers) {
    return (centers && centers[station.id]) || station;
  }

  /**
   * Rough range for train and bus, from straight-line distance only (no timetable).
   * Rails run about 20 % longer than the straight line; long trips mostly use fast trains.
   */
  function transitEstimate(from, to) {
    const km = M.haversineKm(from, to) * 1.2;
    const [fastKmh, slowKmh, extraLow, extraHigh] = km < 120 ? [60, 40, 15, 30] : [120, 85, 20, 45];
    return {
      km,
      lowMin: (km / fastKmh) * 60 + extraLow,
      highMin: (km / slowKmh) * 60 + extraHigh,
    };
  }

  // Google encoded polyline -> [[lat, lon], ...]. Transitous sends the precision with each line.
  function decodePolyline(encoded, precision = 5) {
    const factor = 10 ** precision;
    const points = [];
    let index = 0;
    let lat = 0;
    let lon = 0;
    while (index < encoded.length) {
      const deltas = [0, 0].map(() => {
        let result = 0;
        let shift = 0;
        let byte;
        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        return result & 1 ? ~(result >> 1) : result >> 1;
      });
      lat += deltas[0];
      lon += deltas[1];
      points.push([lat / factor, lon / factor]);
    }
    return points;
  }

  const VEHICLE_ORDER = ["train", "bus", "ferry"];
  const NOT_A_RIDE = new Set(["WALK", "BIKE", "CAR", "RENTAL", "CAR_PARKING", "CAR_DROPOFF"]);

  // Everything on rails (also tram and underground) counts as train.
  function vehicleKind(mode) {
    if (mode === "BUS" || mode === "COACH") return "bus";
    if (mode === "FERRY") return "ferry";
    return "train";
  }

  function localParts(iso, timeZone) {
    const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: timeZone || undefined }).formatToParts(new Date(iso));
    } catch (e) {
      parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(new Date(iso)); // unknown time zone name
    }
    const get = (type) => parts.find((p) => p.type === type).value;
    return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  }

  /** The calendar day (YYYY-MM-DD) of a moment in a time zone. */
  function localDay(iso, timeZone) {
    return localParts(iso, timeZone).day;
  }

  const NIGHT_FROM_MIN = 60; // 01:00
  const NIGHT_TO_MIN = 300; // 05:00

  /** Whether a trip has you on the road between 01:00 and 05:00, by the clock where it starts. */
  function isOvernight(startIso, durationMin, timeZone) {
    const from = localParts(startIso, timeZone).minutes;
    const to = from + durationMin;
    for (let night = NIGHT_FROM_MIN; night < to; night += 1440) {
      if (from < night + (NIGHT_TO_MIN - NIGHT_FROM_MIN) && to > night) return true;
    }
    return false;
  }

  /** Short summary of a Transitous itinerary for the connection list. */
  function summarizeItinerary(it) {
    const legs = it.legs || [];
    const kinds = new Set(legs.filter((l) => !NOT_A_RIDE.has(l.mode)).map((l) => vehicleKind(l.mode)));
    const startTz = legs.length ? legs[0].from.tz || null : null;
    const durationMin = it.duration / 60;
    return {
      start: it.startTime,
      end: it.endTime,
      durationMin,
      transfers: it.transfers,
      vehicles: VEHICLE_ORDER.filter((k) => kinds.has(k)),
      overnight: isOvernight(it.startTime, durationMin, startTz),
      startTz,
      endTz: legs.length ? legs[legs.length - 1].to.tz || null : null,
    };
  }

  const MODE_WORDS = { BUS: "Bus", COACH: "Coach", TRAM: "Tram", FERRY: "Ferry", SUBWAY: "Metro" };

  // Name of a ride as people say it: "ICE 798", "RE30", "Bus 481", "RER D" (bare numbers get their
  // mode, a lone letter the company in front).
  function lineName(leg) {
    const name = leg.displayName || leg.routeShortName || "";
    if (!name) return MODE_WORDS[leg.mode] || "Train";
    if (/^\d+$/.test(name) && MODE_WORDS[leg.mode]) return `${MODE_WORDS[leg.mode]} ${name}`;
    const company = leg.agencyName || "";
    return name.length <= 2 && company && company.length <= 8 ? `${company} ${name}` : name;
  }

  const SHORT_WALK_MIN = 5; // shorter walks at either end aren't worth a line
  const minutesBetween = (fromIso, toIso) => (new Date(toIso) - new Date(fromIso)) / 60000;

  /**
   * A connection step by step, for the details list: a "stop" where you get on or off (with the
   * time and the platform when known), a "ride", a "change" between two rides (with the minutes
   * of it you walk and where to), and a "walk" at the start or the end.
   */
  function connectionSteps(legs) {
    const isRide = (l) => !NOT_A_RIDE.has(l.mode);
    const walkMin = (part) => part.filter((l) => !isRide(l)).reduce((sum, l) => sum + (l.duration || 0) / 60, 0);
    const rides = (legs || []).map((l, i) => (isRide(l) ? i : -1)).filter((i) => i >= 0);
    if (!rides.length) return [];

    const stop = (place, time) => ({ type: "stop", time, tz: place.tz || null, name: place.name, track: place.track || null });
    const steps = [];
    const before = walkMin(legs.slice(0, rides[0]));
    if (before >= SHORT_WALK_MIN) steps.push({ type: "walk", where: "start", durationMin: before });

    rides.forEach((index, n) => {
      const leg = legs[index];
      if (n > 0) {
        const last = legs[rides[n - 1]];
        steps.push({
          type: "change",
          durationMin: minutesBetween(last.endTime, leg.startTime),
          walkMin: walkMin(legs.slice(rides[n - 1] + 1, index)),
          to: leg.from.name !== last.to.name ? leg.from.name : null,
        });
      }
      const towards = leg.tripTo && leg.tripTo.name !== leg.to.name ? leg.tripTo.name : null;
      steps.push(stop(leg.from, leg.startTime));
      steps.push({ type: "ride", kind: vehicleKind(leg.mode), line: lineName(leg), towards, durationMin: leg.duration / 60 });
      steps.push(stop(leg.to, leg.endTime));
    });

    const after = walkMin(legs.slice(rides[rides.length - 1] + 1));
    if (after >= SHORT_WALK_MIN) steps.push({ type: "walk", where: "end", durationMin: after });
    return steps;
  }

  const OVERNIGHT_PENALTY_MIN = 180;
  const CHANGE_PENALTY_MIN = 30;
  const WAIT_PENALTY_MIN = 60;
  const SAME_TRIP_MIN = 20;

  const daysApart = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 864e5);

  // How unpleasant a connection is, in minutes: its length, plus extra for a night on the road, each
  // change, and each day you wait before it leaves (a slightly better trip tomorrow isn't worth a hotel).
  function comfortScore(s, firstDay) {
    return (
      s.durationMin +
      (s.overnight ? OVERNIGHT_PENALTY_MIN : 0) +
      s.transfers * CHANGE_PENALTY_MIN +
      daysApart(firstDay, localDay(s.start, s.startTz)) * WAIT_PENALTY_MIN
    );
  }

  // The same kind of trip a bit later on the same day is no real alternative.
  function muchAlike(a, b) {
    return (
      a.transfers === b.transfers &&
      a.overnight === b.overnight &&
      Math.abs(a.durationMin - b.durationMin) <= SAME_TRIP_MIN &&
      localDay(a.start, a.startTz) === localDay(b.start, b.startTz)
    );
  }

  /**
   * Which connections to show, as indexes into `summaries`: the fastest one first, then the most
   * comfortable real alternatives in the order they leave.
   */
  function pickConnections(summaries, count = 3) {
    const earlier = (a, b) => new Date(summaries[a].start) - new Date(summaries[b].start);
    const all = summaries.map((_, i) => i);
    if (!all.length) return [];
    const fastest = all.reduce((best, i) =>
      (summaries[i].durationMin - summaries[best].durationMin || earlier(i, best)) < 0 ? i : best);
    const firstDay = summaries.map((s) => localDay(s.start, s.startTz)).sort()[0];
    const score = summaries.map((s) => comfortScore(s, firstDay));
    const ranked = all.filter((i) => i !== fastest).sort((a, b) => score[a] - score[b] || earlier(a, b));

    const picked = [fastest];
    const skipped = [];
    for (const i of ranked) {
      if (picked.some((p) => muchAlike(summaries[p], summaries[i]))) skipped.push(i);
      else picked.push(i);
    }
    const chosen = picked.concat(skipped).slice(0, count);
    return [chosen[0], ...chosen.slice(1).sort(earlier)];
  }

  const FLIGHT_OVER_MIN = 10 * 60; // train and bus take longer than this ...
  const FLIGHT_FROM_CHANGES = 10; // ... or need this many changes
  const FLIGHT_MIN_KM = 500; // no flights for shorter hops
  const AIRPORT_MAX_KM = 150; // how far an airport may be from a station

  function nearestAirport(point, airports) {
    let best = null;
    let bestKm = AIRPORT_MAX_KM;
    for (const a of airports || []) {
      const km = M.haversineKm(point, a);
      if (km <= bestKm) [best, bestKm] = [a, km];
    }
    return best;
  }

  // Skyscanner puts the route and the day into the address: /flights/mad/ber/261128/
  function skyscannerUrl(fromCode, toCode, day) {
    const yymmdd = day.slice(2).replace(/-/g, "");
    return `https://www.skyscanner.net/transport/flights/${fromCode}/${toCode}/${yymmdd}/?adultsv2=1&currency=EUR`;
  }

  /**
   * A flight search for the way home, or null when flying makes no sense: inside one country,
   * under 500 km, or when train and bus are good enough (at most 10 hours and fewer than 10
   * changes). `fastest` is the fastest connection ({ durationMin, transfers }), or null when
   * none was found. `from` and `to` need lat, lon and country; `day` is YYYY-MM-DD.
   */
  function flightSearch(from, to, fastest, day, airports) {
    if (from.country && to.country && from.country === to.country) return null;
    if (M.haversineKm(from, to) < FLIGHT_MIN_KM) return null;
    if (fastest && fastest.durationMin <= FLIGHT_OVER_MIN && fastest.transfers < FLIGHT_FROM_CHANGES) return null;
    const a = nearestAirport(from, airports);
    const b = nearestAirport(to, airports);
    if (!a || !b || a.code === b.code) return null;
    return { from: a, to: b, url: skyscannerUrl(a.code, b.code, day) };
  }

  function fuelCost(km, litresPer100Km, pricePerLitre) {
    return ((km * litresPer100Km) / 100) * pricePerLitre;
  }

  const coords = (p) => `${p.lat},${p.lon}`;

  function googleMapsUrl(from, to, travelmode) {
    return `https://www.google.com/maps/dir/?api=1&origin=${coords(from)}&destination=${coords(to)}&travelmode=${travelmode}`;
  }

  return {
    homePoint,
    transitEstimate,
    decodePolyline,
    localDay,
    isOvernight,
    summarizeItinerary,
    connectionSteps,
    pickConnections,
    flightSearch,
    fuelCost,
    googleMapsUrl,
  };
});
