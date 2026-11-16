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
    pickConnections,
    fuelCost,
    googleMapsUrl,
  };
});
