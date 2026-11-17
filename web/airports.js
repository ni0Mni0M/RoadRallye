// Larger European airports, for the "Search for a flight" link on the way home. `code` is what
// Skyscanner takes in its address: the airport's IATA code, or Skyscanner's code for a whole city
// where it has several airports (London, Paris, Milan). Coordinates are rounded; they only pick
// the nearest airport to a station.
// Works as a plain <script> in the browser (window.Airports) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Airports = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const list = [
    // Germany
    ["ber", "Berlin", 52.366, 13.503], ["ham", "Hamburg", 53.63, 9.988], ["muc", "Munich", 48.354, 11.786],
    ["fra", "Frankfurt", 50.033, 8.57], ["dus", "Düsseldorf", 51.289, 6.767], ["cgn", "Cologne", 50.866, 7.143],
    ["str", "Stuttgart", 48.69, 9.222], ["nue", "Nuremberg", 49.499, 11.078], ["haj", "Hanover", 52.461, 9.685],
    ["lej", "Leipzig", 51.424, 12.236], ["bre", "Bremen", 53.047, 8.787], ["drs", "Dresden", 51.133, 13.767],
    ["dtm", "Dortmund", 51.518, 7.612], ["fmm", "Memmingen", 47.989, 10.24], ["fkb", "Karlsruhe", 48.779, 8.08],
    // Austria, Switzerland
    ["vie", "Vienna", 48.11, 16.57], ["szg", "Salzburg", 47.793, 13.004], ["inn", "Innsbruck", 47.26, 11.344],
    ["grz", "Graz", 46.991, 15.44], ["zrh", "Zurich", 47.458, 8.548], ["gva", "Geneva", 46.238, 6.109],
    ["bsl", "Basel", 47.59, 7.529],
    // France
    ["pari", "Paris", 49.01, 2.548], ["pari", "Paris", 48.723, 2.379], ["lys", "Lyon", 45.726, 5.091],
    ["mrs", "Marseille", 43.436, 5.215], ["nce", "Nice", 43.658, 7.216], ["tls", "Toulouse", 43.629, 1.364],
    ["bod", "Bordeaux", 44.828, -0.716], ["nte", "Nantes", 47.153, -1.611], ["sxb", "Strasbourg", 48.538, 7.628],
    ["mpl", "Montpellier", 43.576, 3.963], ["lil", "Lille", 50.563, 3.087], ["rns", "Rennes", 48.069, -1.735],
    ["biq", "Biarritz", 43.468, -1.523],
    // Spain, Portugal
    ["mad", "Madrid", 40.472, -3.561], ["bcn", "Barcelona", 41.297, 2.078], ["vlc", "Valencia", 39.489, -0.482],
    ["agp", "Málaga", 36.675, -4.499], ["svq", "Seville", 37.418, -5.893], ["bio", "Bilbao", 43.301, -2.911],
    ["alc", "Alicante", 38.282, -0.558], ["pmi", "Palma de Mallorca", 39.552, 2.739],
    ["scq", "Santiago de Compostela", 42.896, -8.415], ["ovd", "Asturias", 43.563, -6.035], ["lcg", "A Coruña", 43.302, -8.377],
    ["grx", "Granada", 37.189, -3.777], ["zaz", "Zaragoza", 41.666, -1.042],
    ["lis", "Lisbon", 38.774, -9.134], ["opo", "Porto", 41.248, -8.681], ["fao", "Faro", 37.014, -7.966],
    // Italy
    ["fco", "Rome", 41.8, 12.239], ["mila", "Milan", 45.63, 8.723], ["mila", "Milan", 45.445, 9.277],
    ["mila", "Milan", 45.669, 9.704], ["vce", "Venice", 45.505, 12.352], ["blq", "Bologna", 44.535, 11.289],
    ["nap", "Naples", 40.886, 14.291], ["trn", "Turin", 45.2, 7.65], ["flr", "Florence", 43.81, 11.205],
    ["psa", "Pisa", 43.684, 10.393], ["vrn", "Verona", 45.396, 10.888], ["bri", "Bari", 41.139, 16.761],
    ["cta", "Catania", 37.467, 15.066], ["pmo", "Palermo", 38.176, 13.091], ["goa", "Genoa", 44.413, 8.838],
    ["cag", "Cagliari", 39.251, 9.054], ["olb", "Olbia", 40.899, 9.518],
    // Netherlands, Belgium, Luxembourg
    ["ams", "Amsterdam", 52.309, 4.764], ["ein", "Eindhoven", 51.45, 5.374], ["rtm", "Rotterdam", 51.957, 4.437],
    ["bru", "Brussels", 50.901, 4.484], ["crl", "Charleroi", 50.459, 4.453], ["lux", "Luxembourg", 49.626, 6.212],
    // United Kingdom, Ireland
    ["lond", "London", 51.47, -0.454], ["lond", "London", 51.148, -0.19], ["lond", "London", 51.885, 0.235],
    ["man", "Manchester", 53.354, -2.275], ["edi", "Edinburgh", 55.95, -3.373], ["gla", "Glasgow", 55.872, -4.433],
    ["bhx", "Birmingham", 52.454, -1.748], ["brs", "Bristol", 51.383, -2.719], ["ncl", "Newcastle", 55.038, -1.692],
    ["dub", "Dublin", 53.421, -6.27],
    // Nordic and Baltic countries
    ["cph", "Copenhagen", 55.618, 12.656], ["bll", "Billund", 55.74, 9.152], ["aal", "Aalborg", 57.093, 9.849],
    ["arn", "Stockholm", 59.652, 17.919], ["got", "Gothenburg", 57.663, 12.28], ["mmx", "Malmö", 55.53, 13.372],
    ["osl", "Oslo", 60.194, 11.1], ["bgo", "Bergen", 60.293, 5.218], ["svg", "Stavanger", 58.877, 5.638],
    ["trd", "Trondheim", 63.458, 10.924], ["tos", "Tromsø", 69.683, 18.919], ["hel", "Helsinki", 60.317, 24.963],
    ["kef", "Reykjavík", 63.985, -22.606], ["tll", "Tallinn", 59.413, 24.833], ["rix", "Riga", 56.924, 23.971],
    ["vno", "Vilnius", 54.634, 25.286],
    // Central and south-east Europe
    ["waw", "Warsaw", 52.166, 20.967], ["krk", "Kraków", 50.078, 19.785], ["gdn", "Gdańsk", 54.378, 18.466],
    ["wro", "Wrocław", 51.103, 16.886], ["poz", "Poznań", 52.421, 16.826], ["prg", "Prague", 50.101, 14.26],
    ["bud", "Budapest", 47.437, 19.256], ["lju", "Ljubljana", 46.224, 14.458], ["zag", "Zagreb", 45.743, 16.069],
    ["spu", "Split", 43.539, 16.298], ["dbv", "Dubrovnik", 42.561, 18.268], ["ath", "Athens", 37.936, 23.944],
    ["skg", "Thessaloniki", 40.52, 22.971], ["otp", "Bucharest", 44.571, 26.085], ["sof", "Sofia", 42.695, 23.406],
  ];

  return list.map(([code, city, lat, lon]) => ({ code, city, lat, lon }));
});
