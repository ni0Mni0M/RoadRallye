// Estimates and links for getting from the last drop-off back home: train & bus, car, plane.
// Works as a plain <script> in the browser (window.WayHome) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./matching.js"));
  else root.WayHome = factory(root.RallyMatching);
})(typeof self !== "undefined" ? self : this, function (M) {
  "use strict";

  const AIRPORT_SEARCH_KM = 200;
  const AIRPORT_TIME_MIN = 120; // check-in, security, boarding, then bags and getting out
  const SHORT_FLIGHT_KM = 300;

  // Rough door-to-door minutes by road: 30 % detour, 70 km/h average, 10 min to get going.
  const groundMin = (km) => ((km * 1.3) / 70) * 60 + 10;

  // Airports near a point, best first. Busy airports win over slightly closer quiet ones,
  // so Marburg flies from Frankfurt rather than from Kassel, which has hardly any flights.
  function rankAirports(point, airports) {
    const penalty = (routes) => (routes >= 100 ? 0 : routes >= 40 ? 30 : routes >= 15 ? 70 : 150);
    return airports
      .map((a) => ({ ...a, km: M.haversineKm(point, a) }))
      .filter((a) => a.km <= AIRPORT_SEARCH_KM)
      .sort((a, b) => a.km + penalty(a.routes) - (b.km + penalty(b.routes)));
  }

  /**
   * Door-to-door estimate for flying from `from` to `to`.
   * Returns { reason: "noAirport" | "sameAirport" } when flying makes no sense, otherwise
   * { dep, arr, depAlternatives, arrAlternatives, flightKm, toAirportMin, airportMin, flightMin,
   *   fromAirportMin, totalMin, tooShort }. dep/arr include `km` from the start/end point.
   */
  function planeEstimate(from, to, airports) {
    const deps = rankAirports(from, airports);
    const arrs = rankAirports(to, airports);
    if (!deps.length || !arrs.length) return { reason: "noAirport" };
    const dep = deps[0];
    const arr = arrs[0];
    if (dep.iata === arr.iata) return { reason: "sameAirport" };

    const flightKm = M.haversineKm(dep, arr);
    const toAirportMin = groundMin(dep.km);
    const fromAirportMin = groundMin(arr.km);
    const flightMin = (flightKm / 750) * 60 + 30; // cruise speed plus taxi, climb and descent
    return {
      dep,
      arr,
      depAlternatives: deps.slice(1, 3),
      arrAlternatives: arrs.slice(1, 3),
      flightKm,
      toAirportMin,
      airportMin: AIRPORT_TIME_MIN,
      flightMin,
      fromAirportMin,
      totalMin: toAirportMin + AIRPORT_TIME_MIN + flightMin + fromAirportMin,
      tooShort: flightKm < SHORT_FLIGHT_KM,
    };
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

  const MODE_WORDS = { BUS: "Bus", COACH: "Coach", TRAM: "Tram", FERRY: "Ferry", SUBWAY: "U" };

  // Name of a ride as people say it: "ICE 798", "RE30", "Bus 481" (bare numbers get their mode).
  function lineName(leg) {
    const name = leg.displayName || leg.routeShortName || "";
    if (!name) return MODE_WORDS[leg.mode] || "Train";
    return /^\d+$/.test(name) && MODE_WORDS[leg.mode] ? `${MODE_WORDS[leg.mode]} ${name}` : name;
  }

  /** Short summary of a Transitous itinerary for the connection list. */
  function summarizeItinerary(it) {
    const legs = it.legs || [];
    const rides = legs.filter((l) => l.mode !== "WALK");
    return {
      start: it.startTime,
      end: it.endTime,
      durationMin: it.duration / 60,
      transfers: it.transfers,
      lines: rides.map(lineName),
      startTz: legs.length ? legs[0].from.tz || null : null,
      endTz: legs.length ? legs[legs.length - 1].to.tz || null : null,
    };
  }

  function fastestIndex(summaries) {
    let best = -1;
    summaries.forEach((s, i) => {
      if (best < 0 || s.durationMin < summaries[best].durationMin) best = i;
    });
    return best;
  }

  function fuelCost(km, litresPer100Km, pricePerLitre) {
    return ((km * litresPer100Km) / 100) * pricePerLitre;
  }

  const coords = (p) => `${p.lat},${p.lon}`;

  function googleMapsUrl(from, to, travelmode) {
    return `https://www.google.com/maps/dir/?api=1&origin=${coords(from)}&destination=${coords(to)}&travelmode=${travelmode}`;
  }

  function skyscannerUrl(depIata, arrIata, isoDate) {
    const yymmdd = isoDate.slice(2).replace(/-/g, "");
    return `https://www.skyscanner.net/transport/flights/${depIata.toLowerCase()}/${arrIata.toLowerCase()}/${yymmdd}/`;
  }

  function googleFlightsUrl(depIata, arrIata, isoDate) {
    const q = `one way flights from ${depIata} to ${arrIata} on ${isoDate}`;
    return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
  }

  return {
    rankAirports,
    planeEstimate,
    transitEstimate,
    decodePolyline,
    summarizeItinerary,
    fastestIndex,
    fuelCost,
    googleMapsUrl,
    skyscannerUrl,
    googleFlightsUrl,
  };
});
