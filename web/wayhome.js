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

  return {
    homePoint,
    transitEstimate,
    decodePolyline,
    summarizeItinerary,
    fastestIndex,
    fuelCost,
    googleMapsUrl,
  };
});
