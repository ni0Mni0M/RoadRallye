// The central station of each roadsurfer city, keyed by roadsurfer station id. The depots are
// often in a suburb or the next town, so the way home ends here instead. Coordinates from
// OpenStreetMap (Nominatim). Cities with several names use the first one; Paris and London have
// no single central station, so they use Châtelet-Les Halles and St Pancras.
// Works as a plain <script> in the browser (window.CityCenters) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CityCenters = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    16: { name: "Aix-en-Provence station", lat: 43.5227, lon: 5.4451 }, // Aix-Marseille
    32: { name: "Amsterdam Centraal", lat: 52.3789, lon: 4.9006 }, // Amsterdam
    47: { name: "Antwerpen-Centraal", lat: 51.216, lon: 4.4211 }, // Antwerp
    108: { name: "Augsburg Hbf", lat: 48.3655, lon: 10.8857 }, // Augsburg
    17: { name: "Barcelona Sants", lat: 41.3815, lon: 2.1411 }, // Barcelona
    94: { name: "Bergamo station", lat: 45.6904, lon: 9.675 }, // Bergamo
    6: { name: "Berlin Hbf", lat: 52.525, lon: 13.3694 }, // Berlin
    51: { name: "Berlin Hbf", lat: 52.525, lon: 13.3694 }, // Berlin-Schönefeld
    91: { name: "Bielefeld Hbf", lat: 52.0293, lon: 8.5327 }, // Bielefeld
    40: { name: "Bilbao Abando", lat: 43.2598, lon: -2.9286 }, // Bilbao
    24: { name: "Bochum Hbf", lat: 51.4785, lon: 7.2232 }, // Bochum
    57: { name: "Bologna Centrale", lat: 44.5059, lon: 11.3433 }, // Bologna
    13: { name: "Bordeaux Saint-Jean", lat: 44.8258, lon: -0.5561 }, // Bordeaux
    128: { name: "Braunschweig Hbf", lat: 52.2521, lon: 10.5403 }, // Braunschweig
    55: { name: "Bremen Hbf", lat: 53.0831, lon: 8.8135 }, // Bremen
    98: { name: "Bristol Temple Meads", lat: 51.4491, lon: -2.5804 }, // Bristol
    42: { name: "Brussels-Central", lat: 50.8455, lon: 4.357 }, // Brussels
    52: { name: "Köln Hbf", lat: 50.9428, lon: 6.9591 }, // Cologne-Bonn
    4: { name: "Köln Hbf", lat: 50.9428, lon: 6.9591 }, // Cologne-Dusseldorf
    10: { name: "Konstanz station", lat: 47.6588, lon: 9.1771 }, // Constance (Aach)
    56: { name: "Dresden Hbf", lat: 51.0404, lon: 13.7315 }, // Dresden
    93: { name: "Dublin Connolly", lat: 53.3527, lon: -6.2471 }, // Dublin
    113: { name: "Duisburg Hbf", lat: 51.4297, lon: 6.7762 }, // Duisburg
    64: { name: "Edinburgh Waverley", lat: 55.9519, lon: -3.1904 }, // Edinburgh
    90: { name: "Erfurt Hbf", lat: 50.9728, lon: 11.0379 }, // Erfurt
    130: { name: "Flensburg station", lat: 54.7741, lon: 9.4365 }, // Flensburg
    80: { name: "Firenze Santa Maria Novella", lat: 43.7776, lon: 11.2474 }, // Florence
    2: { name: "Frankfurt (Main) Hbf", lat: 50.1067, lon: 8.6626 }, // Frankfurt
    9: { name: "Freiburg (Breisgau) Hbf", lat: 47.9977, lon: 7.8413 }, // Freiburg-Basel (Germany)
    29: { name: "Genève Cornavin", lat: 46.2102, lon: 6.1426 }, // Geneva-Pays de Gex (France)
    77: { name: "Göteborg Central", lat: 57.7093, lon: 11.9732 }, // Gothenburg
    37: { name: "Graz Hbf", lat: 47.0722, lon: 15.4172 }, // Graz
    3: { name: "Hamburg Hbf", lat: 53.5527, lon: 10.0076 }, // Hamburg
    7: { name: "Hannover Hbf", lat: 52.3765, lon: 9.741 }, // Hanover
    79: { name: "Heidelberg Hbf", lat: 49.4035, lon: 8.6754 }, // Heidelberg
    46: { name: "Innsbruck Hbf", lat: 47.2633, lon: 11.401 }, // Innsbruck-Wiesing
    110: { name: "Karlsruhe Hbf", lat: 48.9936, lon: 8.4021 }, // Karlsruhe
    92: { name: "Kassel Hbf", lat: 51.3183, lon: 9.4896 }, // Kassel
    8: { name: "Leipzig Hbf", lat: 51.3466, lon: 12.3831 }, // Leipzig
    87: { name: "Lille Flandres", lat: 50.6364, lon: 3.0705 }, // Lille
    117: { name: "Lindau-Insel", lat: 47.5442, lon: 9.6808 }, // Lindau-Wangen
    116: { name: "Linz Hbf", lat: 48.2905, lon: 14.2912 }, // Linz
    63: { name: "London St Pancras", lat: 51.5319, lon: -0.1266 }, // London
    15: { name: "Lyon Part-Dieu", lat: 45.7606, lon: 4.8602 }, // Lyon
    109: { name: "Lübeck Hbf", lat: 53.8671, lon: 10.6705 }, // Lübeck
    20: { name: "Madrid Atocha", lat: 40.407, lon: -3.6886 }, // Madrid
    21: { name: "Málaga María Zambrano", lat: 36.7116, lon: -4.4324 }, // Malaga
    60: { name: "Malmö Central", lat: 55.6092, lon: 12.9998 }, // Malmo
    99: { name: "Manchester Piccadilly", lat: 53.4774, lon: -2.2308 }, // Manchester
    22: { name: "Marburg (Lahn) station", lat: 50.8191, lon: 8.7746 }, // Marburg
    34: { name: "Milano Centrale", lat: 45.4859, lon: 9.2043 }, // Milan
    1: { name: "München Hbf", lat: 48.1407, lon: 11.5569 }, // Munich
    31: { name: "Nantes station", lat: 47.2171, lon: -1.5414 }, // Nantes
    88: { name: "Nice-Ville", lat: 43.7044, lon: 7.2616 }, // Nice
    11: { name: "Nürnberg Hbf", lat: 49.4452, lon: 11.0823 }, // Nuremberg
    48: { name: "Paris Châtelet-Les Halles", lat: 48.8616, lon: 2.347 }, // Paris Airport CDG
    12: { name: "Paris Châtelet-Les Halles", lat: 48.8616, lon: 2.347 }, // Paris South (Orly)
    41: { name: "Porto São Bento", lat: 41.1455, lon: -8.6105 }, // Porto
    89: { name: "Regensburg Hbf", lat: 49.0122, lon: 12.0997 }, // Regensburg
    35: { name: "Roma Termini", lat: 41.9012, lon: 12.5017 }, // Rome Fiumicino Airport
    33: { name: "Rotterdam Centraal", lat: 51.9251, lon: 4.4692 }, // Rotterdam
    85: { name: "Salzburg Hbf", lat: 47.8131, lon: 13.0459 }, // Salzburg
    39: { name: "Sevilla Santa Justa", lat: 37.393, lon: -5.9741 }, // Seville
    59: { name: "Stockholm Central", lat: 59.3301, lon: 18.0582 }, // Stockholm
    49: { name: "Strasbourg station", lat: 48.5853, lon: 7.7339 }, // Strasbourg
    5: { name: "Stuttgart Hbf", lat: 48.7856, lon: 9.1834 }, // Stuttgart
    30: { name: "Toulouse Matabiau", lat: 43.6114, lon: 1.4537 }, // Toulouse
    28: { name: "Trier Hbf", lat: 49.757, lon: 6.652 }, // Trier
    58: { name: "Torino Porta Nuova", lat: 45.0619, lon: 7.6784 }, // Turin
    112: { name: "Ulm Hbf", lat: 48.3994, lon: 9.9826 }, // Ulm
    38: { name: "València Nord", lat: 39.4661, lon: -0.3778 }, // Valencia
    78: { name: "Venezia Santa Lucia", lat: 45.4411, lon: 12.321 }, // Venice
    36: { name: "Wien Hbf", lat: 48.185, lon: 16.3779 }, // Vienna
    45: { name: "Wien Hbf", lat: 48.185, lon: 16.3779 }, // Vienna South
    115: { name: "Würzburg Hbf", lat: 49.8015, lon: 9.936 }, // Würzburg
    61: { name: "Zürich HB", lat: 47.3781, lon: 8.5394 }, // Zurich (Wetzikon)
  };
});
