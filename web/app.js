(function () {
  "use strict";

  const M = window.RallyMatching;
  const W = window.WayHome;
  const R = window.RallyRanking;
  const data = window.RALLY_DATA;
  const routeData = window.ROUTE_DATA || null; // road, countries and scenery per route (fetch_route_info.py)
  const climateData = window.CLIMATE_DATA || null; // typical weather per station (fetch_climate.py)
  const $ = (id) => document.getElementById(id);

  const STORAGE_KEY = "rally-finder-settings-v1";
  const PERSONAL_KEY = "rally-finder-personal-v1";
  const PAGE_SIZE = 100;
  // Where each provider's rallies are booked. Stations saved before Imoova was added have no provider: roadsurfer.
  const PROVIDERS = {
    roadsurfer: {
      name: "roadsurfer",
      unit: "rallies",
      note: "Rallies, usually from €129",
      book: (r) =>
        "https://booking.roadsurfer.com/rally/pick" +
        `?station=${r.from}&end_station=${r.to}&pickup_date=${r.pickup}&return_date=${r.return}&currency=EUR`,
    },
    imoova: {
      name: "Imoova",
      unit: "relocations",
      note: "Many rental companies, €1 a day plus a booking fee",
      book: (r) => `https://www.imoova.com/en/relocations/${encodeURIComponent(r.ref)}`,
    },
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const css = getComputedStyle(document.documentElement);
  const cssVar = (name) => css.getPropertyValue(name).trim();
  const COLORS = {
    out: cssVar("--out"),
    back: cssVar("--back"),
    mid: cssVar("--mid"),
    hop: cssVar("--hop"),
    far: cssVar("--far"),
    panel: cssVar("--panel"),
    ink: cssVar("--text"),
  };

  const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fmtDay = (iso) => dayFmt.format(new Date(iso + "T00:00:00Z"));
  const fmtKm = (km) => `${Math.round(km).toLocaleString("en-GB")} km`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtPrice(amount, currency) {
    try {
      const opts = { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 };
      return new Intl.NumberFormat("en-GB", opts).format(amount);
    } catch (e) {
      return `${Math.round(amount)} ${currency}`; // unknown currency code
    }
  }

  // Prices are shown in euros. Other currencies are converted at the ECB rate saved with the data
  // ("≈ €91"), with the listed price in the tooltip; without a rate the listed price is shown.
  function priceHtml(r) {
    if (typeof r.price !== "number") return "";
    const currency = r.currency || "EUR";
    const rate = currency !== "EUR" && data.rates && data.rates.per_eur[currency];
    if (!rate) return esc(fmtPrice(r.price, currency));
    const listed = `${fmtPrice(r.price, currency)} at the ECB rate of ${data.rates.date}`;
    return `<span title="${esc(listed)}">≈ ${esc(fmtPrice(r.price / rate, "EUR"))}</span>`;
  }

  // The listed price in euros for the cost estimates, or null for rallies without one (roadsurfer's).
  // Without a saved rate the listed amount is used as is (US$ and € are close enough for an estimate).
  function priceEur(r) {
    if (typeof r.price !== "number") return null;
    const currency = r.currency || "EUR";
    const rate = currency !== "EUR" && data.rates && data.rates.per_eur[currency];
    return rate ? r.price / rate : r.price;
  }

  // "4 h 55 min", rounded to 5 minutes since every duration here is an estimate.
  function fmtDuration(min) {
    const m = Math.max(5, Math.round(min / 5) * 5);
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
  }

  // "4–6½ h", or "40–70 min" for short trips.
  function fmtRange(lowMin, highMin) {
    if (highMin < 90) return `${Math.round(lowMin / 10) * 10}–${Math.round(highMin / 10) * 10} min`;
    const half = (h) => (Number.isInteger(h) ? `${h}` : `${Math.floor(h) || ""}½`);
    return `${half(Math.floor(lowMin / 30) / 2)}–${half(Math.ceil(highMin / 30) / 2)} h`;
  }

  // What rally i is to its trip, for the colours. The first is "out". In a round trip the last is "back"
  // and one in between "mid"; in a one-way trip every later rally is "mid" (onward), as none comes back.
  const legKind = (t, i) => (i === 0 ? "out" : t.type !== "oneway" && i === t.legs.length - 1 ? "back" : "mid");

  const stopsOf = R.stopsOf;

  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ---------- Map setup ----------

  const map = L.map("map", { zoomSnap: 0.25, worldCopyJump: true }).setView([51, 10], 5);
  // OpenStreetMap tiles need a Referer, so open the page through open-site.bat rather than from disk.
  // style.css mutes their colours (and inverts them in dark mode) so the routes stand out.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  for (const [name, z] of [["areas", 405], ["overview", 410], ["stations", 420], ["wayhome", 425], ["sites", 428], ["trip", 430]]) {
    map.createPane(name).style.zIndex = z;
  }
  map.getPane("areas").style.pointerEvents = "none";
  map.getPane("overview").style.pointerEvents = "none";

  const layers = {
    home: L.layerGroup().addTo(map),
    overview: L.layerGroup().addTo(map),
    stations: L.layerGroup().addTo(map),
    wayHome: L.layerGroup().addTo(map),
    trip: L.layerGroup().addTo(map),
    demo: L.layerGroup().addTo(map), // the sample routes behind the landing page
  };

  const homeIcon = L.divIcon({
    className: "home-pin",
    html: '<div><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 11 12 3.5 21 11v9.5h-6.5v-6h-5v6H3z" fill="currentColor"/></svg></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  const vanIcon = L.divIcon({
    className: "van-pin",
    html:
      '<div><svg viewBox="0 0 32 20" width="24" height="15" aria-hidden="true">' +
      '<path d="M3 2.5h17.4a3 3 0 0 1 2.4 1.2l5 6.6c.5.7.7 1.4.7 2.2V15a1.5 1.5 0 0 1-1.5 1.5h-24A1.5 1.5 0 0 1 1.5 15V4A1.5 1.5 0 0 1 3 2.5z" fill="currentColor"/>' +
      '<rect x="4" y="5" width="12.5" height="4.2" rx="1" fill="#fff" opacity=".9"/>' +
      '<path d="M19 5h1.6a1.5 1.5 0 0 1 1.2.6l2.9 3.6H19z" fill="#fff" opacity=".9"/>' +
      '<circle cx="8" cy="16.5" r="2.7" fill="#2a2a28" stroke="#fff" stroke-width="1.2"/>' +
      '<circle cx="23" cy="16.5" r="2.7" fill="#2a2a28" stroke="#fff" stroke-width="1.2"/>' +
      "</svg></div>",
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });

  // National parks (a triangle, like a tree) and World Heritage sites (a diamond) along a selected trip.
  const siteIcon = (kind, path) =>
    L.divIcon({
      className: `site-pin ${kind}`,
      html: `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="${path}"/></svg>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  const SITE_ICONS = { park: siteIcon("park", "M7 1.5 12.8 12H1.2z"), unesco: siteIcon("unesco", "M7 1 13 7 7 13 1 7z") };
  const SITE_KINDS = { park: "National park", unesco: "World Heritage site" };

  if (!data || !Array.isArray(data.rallies)) {
    $("dataInfo").textContent = "No rally data yet.";
    $("results").innerHTML =
      '<li class="empty">Run <code>update-data.bat</code> (or <code>python scraper/fetch_rallies.py</code>) ' +
      "to download the current rallies, then reload this page.</li>";
    $("playAll").hidden = true;
    document.documentElement.classList.remove("landing"); // nothing to choose from yet
    return;
  }

  // ---------- Data and settings ----------

  const stations = new Map(
    data.stations.filter((s) => typeof s.lat === "number" && typeof s.lon === "number").map((s) => [s.id, s])
  );
  const stationById = new Map([...stations.keys()].map((id) => [String(id), id])); // data-* attributes are strings
  const providerById = new Map(data.stations.map((s) => [s.id, s.provider || "roadsurfer"]));
  const providerOf = (r) => providerById.get(r.from) || "roadsurfer";
  const providerName = (p) => (PROVIDERS[p] ? PROVIDERS[p].name : p);
  const present = new Set(data.rallies.map(providerOf));
  const providersInData = [...Object.keys(PROVIDERS).filter((p) => present.has(p)), ...[...present].filter((p) => !PROVIDERS[p])];

  // Imoova's city centres are often a few km from a roadsurfer station: the home list keeps only the roadsurfer one.
  const roadsurferStations = [...stations.values()].filter((s) => providerById.get(s.id) === "roadsurfer");
  const homeChoices = [...stations.values()].filter(
    (s) => providerById.get(s.id) === "roadsurfer" || !roadsurferStations.some((o) => M.haversineKm(s, o) <= M.SAME_PLACE_KM)
  );
  const homeById = new Map(homeChoices.map((s) => [String(s.id), s.id])); // <select> values are strings

  const today = localToday();
  const berlin = homeChoices.find((s) => s.name === "Berlin");

  const DEFAULTS = {
    home: (berlin || homeChoices[0]).id,
    startRadius: 50,
    returnRadius: 400,
    earliest: today,
    latest: M.addDays(today, 60),
    maxWait: 2,
    hopRadius: 0,
    tripType: "oneway",
    legs: "2", // rallies per round trip
    legsOneWay: "1", // rallies per one-way trip
    sort: "start",
    wayHome: false,
    homeMode: "transit",
    dropoffTime: "12:00",
    carConsumption: 7,
    fuelPrice: 1.8,
    hideProviders: [],
    rallyFee: 129,
    insurance: 15,
    vanConsumption: 10,
    view: "trips",
    rankMode: "destinations",
    rankBy: "dates",
    combine: ["dates", "warmth", "scenic"],
    onlyFavs: false,
    hideVisited: false,
  };
  const TIME_OF_DAY = /^\d\d:\d\d$/;
  const TRIP_TYPES = ["oneway", "round"];
  const LEG_CHOICES = ["2", "2-3", "3"];
  const ONE_WAY_LEG_CHOICES = ["1", "1-2", "1-3"]; // one rally, or chains of up to 2 or 3
  const HOME_MODES = ["transit", "car"];
  const RANK_CHOICES = [...Object.keys(R.METRICS), "favourites", "combined"];

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      saved = {};
    }
    const s = { ...DEFAULTS, ...saved };
    if (!homeById.has(String(s.home))) s.home = DEFAULTS.home;
    if (!Array.isArray(s.hideProviders)) s.hideProviders = [];
    if (!TRIP_TYPES.includes(s.tripType)) s.tripType = DEFAULTS.tripType;
    if (!LEG_CHOICES.includes(s.legs)) s.legs = DEFAULTS.legs;
    if (!ONE_WAY_LEG_CHOICES.includes(s.legsOneWay)) s.legsOneWay = DEFAULTS.legsOneWay;
    if (!HOME_MODES.includes(s.homeMode)) s.homeMode = DEFAULTS.homeMode;
    s.wayHome = s.wayHome === true;
    if (!TIME_OF_DAY.test(s.dropoffTime)) s.dropoffTime = DEFAULTS.dropoffTime;
    for (const key of ["carConsumption", "fuelPrice", "vanConsumption"]) if (!(s[key] > 0)) s[key] = DEFAULTS[key];
    if (!(s.rallyFee >= 0)) s.rallyFee = DEFAULTS.rallyFee;
    if (![0, 15, 29].includes(s.insurance)) s.insurance = DEFAULTS.insurance;
    if (!["trips", "destinations"].includes(s.view)) s.view = DEFAULTS.view;
    if (!["destinations", "starts"].includes(s.rankMode)) s.rankMode = DEFAULTS.rankMode;
    if (!RANK_CHOICES.includes(s.rankBy)) s.rankBy = DEFAULTS.rankBy;
    s.combine = Array.isArray(s.combine) ? s.combine.filter((k) => R.METRICS[k]) : DEFAULTS.combine;
    s.onlyFavs = s.onlyFavs === true;
    s.hideVisited = s.hideVisited === true;
    if (!s.earliest || s.earliest < today) s.earliest = today;
    if (!s.latest || s.latest < s.earliest) s.latest = M.addDays(s.earliest, 60);
    return s;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // Private mode or blocked storage: settings just won't be remembered.
    }
  }

  // Favourite stations and places you've been, kept apart from the filter settings.
  function loadPersonal() {
    try {
      const p = JSON.parse(localStorage.getItem(PERSONAL_KEY)) || {};
      return { fav: new Set(p.fav || []), visited: new Set(p.visited || []) };
    } catch (e) {
      return { fav: new Set(), visited: new Set() };
    }
  }

  function savePersonal() {
    try {
      localStorage.setItem(PERSONAL_KEY, JSON.stringify({ fav: [...personal.fav], visited: [...personal.visited] }));
    } catch (e) {
      // Blocked storage: the marks last until the page is closed.
    }
  }

  let settings = loadSettings();
  const personal = loadPersonal();
  let allTrips = [];
  let trips = [];
  let facts = new Map(); // trip id -> R.tripFacts: cost, road km, countries, scenery
  let rankRows = [];
  let shown = PAGE_SIZE;
  let selectedId = null;
  let via = null; // only trips stopping at this station
  let startVia = null; // only trips starting at this station (from "Where to start")
  let animToken = 0;
  let playToken = 0;
  let playing = false;
  let landing = document.documentElement.classList.contains("landing"); // set in index.html on a first visit
  let mapInsetLeft = 0; // px of the map hidden under the panel while the landing page slides away
  let demoToken = 0;

  // What differs between the two kinds of trip.
  const oneWay = () => settings.tripType === "oneway";
  const tripWord = () => (oneWay() ? "one-way trip" : "round trip");
  const maxLegs = () => (oneWay() ? ONE_WAY_LEG_CHOICES.indexOf(settings.legsOneWay) + 1 : settings.legs === "2" ? 2 : 3);
  // A round trip only passes through the places it stops at; a one-way trip also ends at one.
  const viaWord = () => (!oneWay() ? "via" : maxLegs() === 1 ? "to" : "to or via");

  // ---------- Form ----------

  function fillHomeSelect() {
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const byCountry = new Map();
    for (const s of homeChoices) {
      const country = s.country ? regions.of(s.country) : "Other";
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(s);
    }
    $("home").innerHTML = [...byCountry.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((country) => {
        const options = byCountry
          .get(country)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
          .join("");
        return `<optgroup label="${esc(country)}">${options}</optgroup>`;
      })
      .join("");
  }

  // One checkbox per provider, shown only when the data has more than one.
  function fillProviders() {
    $("providerSet").hidden = providersInData.length < 2;
    $("providers").innerHTML = providersInData
      .map((p) => {
        const note = PROVIDERS[p] ? `<small>${esc(PROVIDERS[p].note)}</small>` : "";
        return `<label class="check"><input type="checkbox" value="${esc(p)}"><span>${esc(providerName(p))}${note}</span></label>`;
      })
      .join("");
  }

  const providerBoxes = () => [...$("providers").querySelectorAll("input")];

  const FIELDS = [
    "home", "startRadius", "returnRadius", "earliest", "latest", "maxWait", "hopRadius", "sort",
    "dropoffTime", "carConsumption", "fuelPrice", "rallyFee", "insurance", "vanConsumption",
  ];
  const NUMERIC = new Set([
    "startRadius", "returnRadius", "maxWait", "hopRadius", "carConsumption", "fuelPrice",
    "rallyFee", "insurance", "vanConsumption",
  ]);
  const RADIOS = ["tripType", "legs", "legsOneWay"]; // the segmented choices inside the filter form
  // Chosen outside the filter form (view switch, ranking controls), so readForm keeps them.
  const OUTSIDE_FORM = ["homeMode", "view", "rankMode", "rankBy", "combine", "onlyFavs", "hideVisited"];

  function writeForm() {
    for (const key of FIELDS) $(key).value = settings[key];
    for (const key of RADIOS) $("filters").elements[key].value = settings[key];
    $("wayHome").checked = settings.wayHome;
    for (const box of providerBoxes()) box.checked = !settings.hideProviders.includes(box.value);
    updateOutputs();
  }

  function readForm() {
    const next = {};
    for (const key of FIELDS) next[key] = NUMERIC.has(key) ? Number($(key).value) : $(key).value;
    next.home = homeById.get(next.home);
    next.hideProviders = providerBoxes().filter((box) => !box.checked).map((box) => box.value);
    for (const key of RADIOS) next[key] = $("filters").elements[key].value;
    next.wayHome = $("wayHome").checked;
    for (const key of OUTSIDE_FORM) next[key] = settings[key];
    if (!TIME_OF_DAY.test(next.dropoffTime)) next.dropoffTime = DEFAULTS.dropoffTime;
    for (const key of ["carConsumption", "fuelPrice", "vanConsumption"]) if (!(next[key] > 0)) next[key] = DEFAULTS[key];
    if (!(next.rallyFee >= 0)) next.rallyFee = DEFAULTS.rallyFee;
    settings = next;
  }

  function updateOutputs() {
    const v = (id) => Number($(id).value);
    $("startRadiusOut").textContent = v("startRadius") === 0 ? "home station only" : fmtKm(v("startRadius"));
    $("returnRadiusOut").textContent = fmtKm(v("returnRadius"));
    $("maxWaitOut").textContent = v("maxWait") === 0 ? "same day only" : `up to ${plural(v("maxWait"), "day")}`;
    $("hopRadiusOut").textContent = v("hopRadius") === 0 ? "off" : `up to ${fmtKm(v("hopRadius"))}`;
    $("wayHomeOptions").hidden = !$("wayHome").checked;

    // One-way or round trip: which filters apply, and what they are called. Read from the form,
    // so the panel follows the switch at once (the trips follow a moment later).
    const form = $("filters").elements;
    const oneWayNow = form.tripType.value === "oneway";
    const chains = !oneWayNow || form.legsOneWay.value !== "1"; // a single rally has no legs to wait or hop between
    $("tripTypeHint").textContent = oneWayNow
      ? "Drive away from home with one rally, or chain up to three. You get home another way."
      : "Out with one rally and back with another, ending near home.";
    $("returnField").hidden = oneWayNow;
    $("latestLabel").textContent = oneWayNow ? "Latest drop-off" : "Back by";
    $("legsOneWayField").hidden = !oneWayNow;
    $("legsRoundField").hidden = oneWayNow;
    $("maxWaitField").hidden = !chains;
    $("hopField").hidden = !chains;
    $("sortDistance").textContent = oneWayNow ? "Ends farthest from home" : "Ends closest to home";
  }

  let debounce;
  function onFilterChange() {
    updateOutputs();
    if (landing) {
      // Nothing is searched or saved before "Show trips"; the map only previews the chosen home.
      if (homeById.get($("home").value) !== demoHome) playDemo();
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      readForm();
      saveSettings();
      stopPlay();
      compute();
    }, 150);
  }

  // ---------- Matching ----------

  // The rallies of the providers that are switched on.
  function visibleRallies() {
    const hidden = new Set(settings.hideProviders);
    return hidden.size ? data.rallies.filter((r) => !hidden.has(providerOf(r))) : data.rallies;
  }

  // One-way trips or round trips from one home station with the current filters (the "via" filter comes on top).
  function tripsFrom(home, rallies) {
    const found = M.findTrips({ stations: data.stations, rallies }, {
      tripType: settings.tripType,
      home,
      startRadiusKm: settings.startRadius,
      returnRadiusKm: settings.returnRadius,
      hopRadiusKm: settings.hopRadius,
      earliest: settings.earliest,
      latest: settings.latest,
      maxWaitDays: settings.maxWait,
      maxLegs: maxLegs(),
      // compute() sorts by cost itself. By distance, round trips list the end closest to home first
      // and one-way trips the farthest.
      sort: settings.sort === "cost" ? "start" : settings.sort === "distance" && oneWay() ? "far" : settings.sort,
    });
    return !oneWay() && settings.legs === "3" ? found.filter((t) => t.legs.length === 3) : found;
  }

  // How many trips each station in the home list would have with the current filters ("Berlin (17)").
  // Counting all of them takes up to a few hundred ms, so it runs in short slices, and only again
  // when a filter other than the home station changed.
  const homeCounts = new Map();
  let countKey = "";
  let countToken = 0;

  function countHomes(error) {
    const key = JSON.stringify([
      error, settings.tripType, settings.startRadius, settings.returnRadius, settings.hopRadius, settings.earliest,
      settings.latest, settings.maxWait, settings.legs, settings.legsOneWay, settings.hideProviders,
    ]);
    if (key === countKey) return;
    countKey = key;
    const token = ++countToken;
    homeCounts.clear();
    if (error) {
      updateHomeLabels();
      return;
    }
    const rallies = visibleRallies();
    const queue = [...homeChoices];
    const slice = () => {
      if (token !== countToken) return; // the filters changed again meanwhile
      const until = performance.now() + 12;
      while (queue.length && performance.now() < until) {
        const s = queue.shift();
        homeCounts.set(s.id, tripsFrom(s, rallies).length);
      }
      if (queue.length) setTimeout(slice, 0);
      else updateHomeLabels();
    };
    setTimeout(slice, 0);
  }

  function updateHomeLabels() {
    for (const option of $("home").options) {
      const s = stations.get(homeById.get(option.value));
      const n = homeCounts.get(s.id);
      option.textContent = n === undefined ? s.name : `${s.name} (${n})`;
    }
  }

  function dateError() {
    if (!settings.earliest || !settings.latest) return "Pick both dates.";
    if (settings.latest < settings.earliest) {
      return `The ${oneWay() ? "latest drop-off" : "back-by date"} is before the earliest pickup.`;
    }
    return "";
  }

  function compute() {
    const error = dateError();
    $("dateError").textContent = error;

    allTrips = error ? [] : tripsFrom(stations.get(settings.home), visibleRallies());
    countHomes(error);
    updateLegend();

    const factsCtx = { stations, routes: routeData && routeData.routes, costs: costSettings() };
    facts = new Map(allTrips.map((t) => [t.id, R.tripFacts(t, factsCtx)]));
    if (settings.sort === "cost") allTrips.sort((a, b) => facts.get(a.id).cost - facts.get(b.id).cost);

    if (via !== null && !allTrips.some((t) => stopsOf(t).has(via))) via = null;
    if (startVia !== null && !allTrips.some((t) => t.legs[0].from === startVia)) startVia = null;
    trips = filterVia(allTrips);
    shown = PAGE_SIZE;

    const keepSelection = settings.view === "trips" && selectedId && trips.some((t) => t.id === selectedId);
    renderList();
    rankRows = computeRanking();
    renderRanking();
    drawBase();
    if (keepSelection) selectTrip(selectedId, { animate: false });
    else clearSelection();
  }

  // The legend only names what the chosen kind of trip can draw.
  function updateLegend() {
    const chains = maxLegs() > (oneWay() ? 1 : 2); // more rallies than the plainest trip of this kind
    $("legendOutText").textContent = oneWay() ? "First rally" : "Outbound rally";
    $("legendMidText").textContent = oneWay() ? "Onward rally" : "Middle rally";
    $("legendMid").hidden = !chains;
    $("legendBack").hidden = oneWay();
    $("legendHop").hidden = oneWay() && !chains;
    $("legendHome").hidden = !settings.wayHome;
    $("legendReturnArea").hidden = oneWay();
  }

  const costSettings = () => ({
    rallyFee: settings.rallyFee,
    insurancePerDay: settings.insurance,
    vanLitresPer100Km: settings.vanConsumption,
    fuelPrice: settings.fuelPrice,
    priceEur,
  });

  const filterVia = (list) =>
    list.filter((t) => (via === null || stopsOf(t).has(via)) && (startVia === null || t.legs[0].from === startVia));

  function setVia(id) {
    via = id;
    startVia = null;
    stopPlay();
    trips = filterVia(allTrips);
    shown = PAGE_SIZE;
    renderList();
    drawBase();
    clearSelection();
  }

  function setHome(id) {
    settings.home = id;
    $("home").value = String(id);
    saveSettings();
    stopPlay();
    compute();
  }

  // The home-list station for a map station: itself, or for an Imoova city the roadsurfer station
  // in the same place (the home list only keeps that one).
  function homeFor(s) {
    if (homeById.has(String(s.id))) return s;
    let best = s;
    let bestKm = Infinity;
    for (const o of roadsurferStations) {
      const km = M.haversineKm(s, o);
      if (km < bestKm) [best, bestKm] = [o, km];
    }
    return best;
  }

  // ---------- List ----------

  function timelineHtml(t) {
    const span = Math.max(1, M.daysBetween(settings.earliest, settings.latest));
    const seg = (cls, from, to) => {
      const left = (M.daysBetween(settings.earliest, from) / span) * 100;
      const width = (M.daysBetween(from, to) / span) * 100;
      return `<span class="${cls}" style="left:${left.toFixed(2)}%;width:${Math.max(width, 0.8).toFixed(2)}%"></span>`;
    };
    const parts = t.legs.map((r, i) => {
      const wait = i > 0 && t.waits[i - 1] > 0 ? seg("wait", t.legs[i - 1].return, r.pickup) : "";
      return wait + seg(legKind(t, i), r.pickup, r.return);
    });
    return `<div class="timeline" aria-hidden="true">${parts.join("")}</div>`;
  }

  // Imoova prices are the booking fee plus the daily rate for the free days; fuel, bond and extra days come on top.
  function legHtml(kind, r) {
    const a = stations.get(r.from);
    const b = stations.get(r.to);
    const p = providerOf(r);
    const source =
      esc(providerName(p)) +
      (r.supplier ? ` (${esc(r.supplier)} van)` : "") +
      (typeof r.price === "number" ? ` · ${priceHtml(r)}` : "");
    const book = PROVIDERS[p]
      ? `<a class="book" href="${esc(PROVIDERS[p].book(r))}" target="_blank" rel="noopener" ` +
        `aria-label="Book ${esc(a.name)} to ${esc(b.name)} on ${esc(providerName(p))}">Book ↗</a>`
      : "";
    return (
      `<div class="leg ${kind}">` +
      '<span class="leg-dot" aria-hidden="true"></span>' +
      '<div class="leg-text">' +
      `<span class="leg-dates">${fmtDay(r.pickup)} → ${fmtDay(r.return)}</span>` +
      '<span class="leg-stations">' +
      `<span class="leg-route">${esc(a.name)} → ${esc(b.name)} · ${plural(M.daysBetween(r.pickup, r.return), "day")}</span>` +
      `<span class="leg-source">${source}</span>` +
      "</span>" +
      "</div>" +
      book +
      "</div>"
    );
  }

  // What happens between two rallies: a train hop, waiting days, or nothing (same-day switch).
  function betweenHtml(t, i) {
    const arrive = stations.get(t.legs[i].to);
    const depart = stations.get(t.legs[i + 1].from);
    const wait = t.waits[i];
    if (arrive.id !== depart.id) {
      const when = wait ? `, ${plural(wait, "day")} later` : ", same day";
      const acrossTown = t.hops[i] <= M.SAME_PLACE_KM && providerById.get(arrive.id) !== providerById.get(depart.id);
      const how = acrossTown ? "Across town" : "Train";
      return `<p class="between">${how} ${esc(arrive.name)} → ${esc(depart.name)} (${fmtKm(t.hops[i])})${when}</p>`;
    }
    return wait ? `<p class="between">${plural(wait, "day")} in ${esc(arrive.name)}</p>` : "";
  }

  function tripHtml(t) {
    const n = t.legs.length;
    const arrow = (sym) => ` <span class="arrow">${sym}</span> `;
    let title = esc(stations.get(t.legs[0].from).name);
    let body = "";
    t.legs.forEach((r, i) => {
      if (i > 0) {
        if (r.from !== t.legs[i - 1].to) title += arrow("⇢") + esc(stations.get(r.from).name);
        body += betweenHtml(t, i - 1);
      }
      title += arrow("→") + esc(stations.get(r.to).name);
      body += legHtml(legKind(t, i), r);
    });
    // "15 days · 3 rallies · 1 day waiting · ends 368 km from home". The rallies are only counted when
    // there are more than the plainest trip of this kind has, and a single rally has nothing to wait for.
    const summary = [plural(t.totalDays, "day")];
    if (n > (t.type === "oneway" ? 1 : 2)) summary.push(`${n} rallies`);
    if (n > 1) summary.push(t.waitDays === 0 ? "no waiting" : `${plural(t.waitDays, "day")} waiting`);
    summary.push(`ends ${fmtKm(t.endKm)} from home`);
    const f = facts.get(t.id);
    const costLine = f
      ? `<p class="facts" title="Rental (rally fee and insurance, or the listed price) and diesel for ${fmtKm(f.roadKm)}${f.measured ? "" : " (distance estimated)"}; no tolls">` +
        `≈ €${Math.round(f.cost).toLocaleString("en-GB")} · ${Math.round(f.kmPerDay)} km a day` +
        `${f.countries.length > 1 ? ` · ${f.countries.join(" → ")}` : ""}</p>`
      : "";

    return (
      `<li class="trip${t.id === selectedId ? " selected" : ""}" data-id="${esc(t.id)}" tabindex="0">` +
      `<h3>${title}</h3>` +
      body +
      `<p class="facts">${summary.join(" · ")}</p>` +
      costLine +
      timelineHtml(t) +
      "</li>"
    );
  }

  // "Berlin → Madrid → Marburg" (with ⇢ for a train hop), as plain text.
  function routeText(t) {
    const names = [stations.get(t.legs[0].from).name];
    t.legs.forEach((r, i) => {
      if (i > 0 && r.from !== t.legs[i - 1].to) names.push(`⇢ ${stations.get(r.from).name}`);
      names.push(stations.get(r.to).name);
    });
    return names.join(" → ").replace(/→ ⇢/g, "⇢");
  }

  function renderList() {
    const n = trips.length;
    // Next to the total: how many trips chain more rallies than the plainest trip of this kind.
    const longer = trips.filter((t) => t.legs.length > (oneWay() ? 1 : 2)).length;
    const longerText =
      oneWay() && maxLegs() > 1 ? ` · ${longer} with ${maxLegs() === 2 ? "2" : "2 or 3"} rallies`
        : !oneWay() && settings.legs === "2-3" ? ` · ${longer} with 3 rallies`
          : "";
    $("resultCount").textContent = n ? plural(n, tripWord()) + longerText : `No ${tripWord()}s`;
    const chip = (label) =>
      `<span class="chip">${label}<button type="button" id="clearVia" aria-label="Show all trips">×</button></span>`;
    const viaText = viaWord();
    $("viaChip").innerHTML =
      via !== null ? chip(`${viaText[0].toUpperCase()}${viaText.slice(1)} ${esc(stations.get(via).name)}`)
        : startVia !== null ? chip(`Starting at ${esc(stations.get(startVia).name)}`)
          : "";

    if (!n) {
      const empty = oneWay()
        ? "No one-way trips match yet. Try a later drop-off date, a bigger start radius, or another home station."
        : settings.legs === "3"
          ? "No trips with 3 rallies match. They need two far-away rallies that line up, " +
            "so try a bigger start radius, more days between legs, or a train hop."
          : "Nothing matches yet. Try a later back-by date, a bigger return radius, " +
            "more days between legs, or a train hop.";
      $("results").innerHTML = $("dateError").textContent ? "" : `<li class="empty">${empty}</li>`;
      return;
    }
    const rest = n - shown;
    $("results").innerHTML =
      trips.slice(0, shown).map(tripHtml).join("") +
      (rest > 0 ? `<li class="more"><button type="button" id="showMore">Show ${Math.min(PAGE_SIZE, rest)} more</button></li>` : "");
  }

  // ---------- Ranking ----------

  const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  const countryName = (code) => {
    try {
      return regionNames.of(code);
    } catch (e) {
      return code;
    }
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const freshSince = R.freshSince(data.fetched_at, data.tracking_since);
  const rankKey = () => (settings.rankBy === "favourites" ? "trips" : settings.rankBy);

  // Why a ranking can't be used right now, or "" when it can.
  function rankUnavailable(key) {
    const m = R.METRICS[key];
    if (!m) return "";
    if (m.types && !m.types.includes(settings.tripType)) return "round trips only";
    if (!m.modes.includes(settings.rankMode)) return "only for where to go";
    if (m.needs === "routes" && !routeData) return "needs route data";
    if (m.needs === "climate" && !climateData) return "needs weather data";
    if (m.needs === "tracking" && !freshSince) return "from the next data update";
    return "";
  }

  function fillRankControls() {
    for (const el of document.querySelectorAll('input[name="view"]')) el.checked = el.value === settings.view;
    for (const el of document.querySelectorAll('input[name="rankMode"]')) el.checked = el.value === settings.rankMode;
    if (rankUnavailable(settings.rankBy)) settings.rankBy = "dates";

    const option = (key, label) => {
      const why = rankUnavailable(key);
      return `<option value="${key}"${why ? " disabled" : ""}>${esc(label)}${why ? ` (${why})` : ""}</option>`;
    };
    const groups = new Map();
    for (const [key, m] of Object.entries(R.METRICS)) {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group).push(key);
    }
    $("rankBy").innerHTML =
      [...groups].map(([g, keys]) => `<optgroup label="${esc(g)}">${keys.map((k) => option(k, R.METRICS[k].label)).join("")}</optgroup>`).join("") +
      `<optgroup label="Personal">${option("favourites", "Favourites first")}</optgroup>` +
      `<optgroup label="Several at once">${option("combined", "Combined score")}</optgroup>`;
    $("rankBy").value = settings.rankBy;

    $("combineChips").hidden = settings.rankBy !== "combined";
    $("combineChips").innerHTML = Object.entries(R.METRICS)
      .filter(([k]) => !rankUnavailable(k))
      .map(([k, m]) => `<label class="chip-check"><input type="checkbox" value="${k}"${settings.combine.includes(k) ? " checked" : ""}><span>${esc(m.label)}</span></label>`)
      .join("");
    $("onlyFavs").checked = settings.onlyFavs;
    $("hideVisited").checked = settings.hideVisited;
  }

  function computeRanking() {
    if (!allTrips.length) return [];
    if (rankUnavailable(settings.rankBy)) settings.rankBy = "dates";
    const rows = R.rankStations(allTrips, { stations, facts }, {
      mode: settings.rankMode,
      tripType: settings.tripType,
      by: rankKey(),
      combine: settings.combine,
      home: stations.get(settings.home),
      today,
      freshSince,
      climate: climateData,
    });
    if (settings.rankBy === "favourites") {
      rows.sort((a, b) => Number(personal.fav.has(b.id)) - Number(personal.fav.has(a.id)) || b.trips - a.trips);
    }
    return rows;
  }

  const visibleRankRows = () =>
    rankRows.filter((r) => (!settings.onlyFavs || personal.fav.has(r.id)) && (!settings.hideVisited || !personal.visited.has(r.id)));

  function fmtMetric(key, v) {
    if (v === null || v === undefined) return "–";
    const money = (x) => `€${Math.round(x).toLocaleString("en-GB")}`;
    switch (key) {
      case "dates": return plural(v, "date");
      case "backups": return `${v.toLocaleString("en-GB")} per departure`;
      case "trips": return plural(v, "trip");
      case "stay": return v ? plural(v, "day") : "same day";
      case "pace": return `${Math.round(v)} km/day`;
      case "distance": return fmtKm(v);
      case "countries": return v === 1 ? "1 country" : `${v} countries`;
      case "warmth": return `${Math.round(v)} °C`;
      case "sun": return `${v.toFixed(1)} h sun`;
      case "dry": return `${Math.round(v)} rainy days`;
      case "scenic": return `${Math.round(v)} points`;
      case "cost": return money(v);
      case "costPerDay": return `${money(v)}/day`;
      case "fresh": return `${v} new`;
      case "soonest": return v === 0 ? "today" : v === 1 ? "tomorrow" : `in ${v} days`;
      case "combined": return `${Math.round(v * 100)}/100`;
      default: return String(v);
    }
  }

  function weatherText(row) {
    const months = climateData && climateData.stations[String(row.id)];
    if (!months || row.arrivalMonth === null) return "";
    const w = months[row.arrivalMonth];
    return `Arriving in ${MONTHS[row.arrivalMonth]}: ${Math.round(w.t)} °C highs, ${w.sun} h of sun a day, ` +
      `${Math.round(w.rain)} rainy days (${esc(climateData.period)} average)`;
  }

  function scenicText(t) {
    const f = facts.get(t.id);
    const parts = [
      f.parks.length && plural(f.parks.length, "national park"),
      f.unesco.length && `${f.unesco.length} UNESCO site${f.unesco.length === 1 ? "" : "s"}`,
      f.coastKm && `${fmtKm(f.coastKm)} by the sea`,
      f.mountainKm && `${fmtKm(f.mountainKm)} above 1,000 m`,
    ].filter(Boolean);
    const names = [...f.parks, ...f.unesco];
    return (
      `${parts.length ? parts.join(" · ") : "No parks, World Heritage sites, coast or mountains"} on ${esc(routeText(t))}` +
      (names.length
        ? `<span class="rank-names">${esc(names.slice(0, 4).join(", "))}${names.length > 4 ? `, +${names.length - 4} more` : ""}</span>`
        : "")
    );
  }

  // One line explaining the figure a station is ranked by.
  function detailHtml(row, key) {
    const f = (t) => facts.get(t.id);
    switch (key) {
      case "scenic":
        return row.best.scenic ? scenicText(row.best.scenic) : "";
      case "countries":
        return esc(f(row.best.countries).countries.map(countryName).join(" → "));
      case "warmth":
      case "sun":
      case "dry":
        return weatherText(row);
      case "cost":
      case "costPerDay": {
        const t = row.best.cost;
        return `From €${Math.round(f(t).cost).toLocaleString("en-GB")} for ${esc(routeText(t))}, ${plural(t.totalDays, "day")}`;
      }
      case "pace":
        return `${Math.round(f(row.best.pace).kmPerDay)} km a day on ${esc(routeText(row.best.pace))}`;
      case "stay":
        return row.values.stay ? `Up to ${plural(row.values.stay, "day")} there between rallies` : "You switch vans the same day";
      case "fresh":
        return `${row.values.fresh} of ${plural(row.trips, "trip")} use rallies first seen since ${fmtDay(freshSince)}`;
      case "soonest":
        return `First departure ${fmtDay(row.dateList[0])}`;
      case "distance":
        return `${fmtKm(row.values.distance)} from ${esc(stations.get(settings.home).name)} as the crow flies`;
      case "combined":
        return (
          '<span class="rank-parts">' +
          Object.entries(row.parts)
            .map(([k, p]) => `<span class="part"><span>${esc(R.METRICS[k].label)}</span><span class="part-bar"><i style="width:${Math.round(p * 100)}%"></i></span></span>`)
            .join("") +
          "</span>"
        );
      default: {
        const shown3 = row.dateList.slice(0, 3).map(fmtDay).join(", ");
        return `Leave on ${shown3}${row.dateList.length > 3 ? `, +${row.dateList.length - 3} more` : ""}`;
      }
    }
  }

  function dateStripHtml(row) {
    const span = Math.max(1, M.daysBetween(settings.earliest, settings.latest));
    return (
      '<div class="rank-strip" aria-hidden="true">' +
      row.dateList.map((d) => `<i style="left:${((M.daysBetween(settings.earliest, d) / span) * 100).toFixed(1)}%"></i>`).join("") +
      "</div>"
    );
  }

  function rankRowHtml(row, position) {
    const key = rankKey();
    const fav = personal.fav.has(row.id);
    const been = personal.visited.has(row.id);
    const away = settings.rankMode === "destinations" ? ` · ${fmtKm(M.haversineKm(stations.get(settings.home), stations.get(row.id)))} away` : "";
    return (
      `<li class="rank-row" data-station="${esc(row.id)}" tabindex="0">` +
      `<span class="rank-no">${row.rank === null ? "–" : position}</span>` +
      '<div class="rank-main">' +
      `<h3>${esc(row.name)} <span class="rank-country">${esc(countryName(row.country))}</span></h3>` +
      `<p class="rank-sub">${plural(row.values.dates, "departure date")} · ${plural(row.trips, tripWord())}${away}</p>` +
      `<p class="rank-detail">${detailHtml(row, key)}</p>` +
      dateStripHtml(row) +
      "</div>" +
      '<div class="rank-side">' +
      `<span class="rank-value">${fmtMetric(key, row.values[key])}</span>` +
      '<span class="rank-actions">' +
      `<button type="button" class="icon-btn" data-fav aria-pressed="${fav}" title="Favourite" aria-label="Favourite: ${esc(row.name)}">${fav ? "★" : "☆"}</button>` +
      `<button type="button" class="icon-btn" data-visited aria-pressed="${been}" title="Been there" aria-label="Been there: ${esc(row.name)}">✓</button>` +
      "</span></div></li>"
    );
  }

  function renderRanking() {
    fillRankControls();
    $("tripsView").hidden = settings.view !== "trips";
    $("rankView").hidden = settings.view !== "destinations";
    $("playAll").hidden = settings.view !== "trips";
    if (settings.view !== "destinations") return;

    const rows = visibleRankRows();
    const what =
      settings.rankMode === "starts" ? `stations your ${tripWord()}s start from`
        : oneWay() ? "places your one-way trips take you to"
          : "places your round trips stop at";
    $("rankCount").textContent = rows.length ? `${plural(rows.length, "station")}: ${what}` : "";

    const notes = [];
    if (!routeData) notes.push("Road distances and scenery are missing, so costs and pace are estimates. Run update-data.bat.");
    if (!climateData) notes.push("Weather data is missing. Run update-data.bat.");
    if (!freshSince && data.tracking_since) notes.push(`New rallies are tracked since ${fmtDay(data.tracking_since)}; they show from the next update.`);
    if (rows.length && rows.every((r) => r.rank === null)) {
      notes.push("None of these stations has this figure yet, probably because route data is incomplete. Run update-data.bat.");
    }
    $("rankNote").textContent = notes.join(" ");

    $("ranking").innerHTML = rows.length
      ? rows.map((r, i) => rankRowHtml(r, i + 1)).join("")
      : `<li class="empty">${allTrips.length ? "No station matches these marks. Untick the favourites or visited filter." : `No ${tripWord()}s with these filters, so nothing to rank.`}</li>`;

    const key = rankKey();
    const credits = [];
    if (["warmth", "sun", "dry"].includes(key) || (key === "combined" && settings.combine.some((k) => ["warmth", "sun", "dry"].includes(k)))) {
      credits.push('Weather: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>');
    }
    if (routeData) {
      credits.push(
        'Roads: <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> · borders and coast: Natural Earth · ' +
        "national parks: Wikidata · World Heritage sites: OpenStreetMap"
      );
    }
    $("rankCredits").innerHTML = credits.join("<br>");
  }

  function drawRankMarkers() {
    const key = rankKey();
    visibleRankRows()
      .filter((r) => r.rank !== null)
      .forEach((row, i) => {
        const s = stations.get(row.id);
        const top = i < 10;
        const marker = top
          ? L.marker([s.lat, s.lon], {
              icon: L.divIcon({ className: "rank-pin", html: `<div>${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
              zIndexOffset: 1000 - i,
              keyboard: false,
            })
          : L.circleMarker([s.lat, s.lon], { pane: "stations", radius: 5, color: COLORS.panel, weight: 1.5, fillColor: COLORS.out, fillOpacity: 0.8 });
        marker
          .bindTooltip(`<strong>${i + 1}. ${esc(s.name)}</strong><br>${fmtMetric(key, row.values[key])} · click for its trips`, {
            direction: "top",
            offset: [0, top ? -12 : -5],
          })
          .on("click", () => openStation(row.id))
          .addTo(layers.stations);
      });
  }

  // From the ranking to the trips through (or starting at) one station.
  function openStation(id) {
    if (settings.rankMode === "starts") {
      startVia = id;
      via = null;
    } else {
      via = id;
      startVia = null;
    }
    setView("trips");
    $("tripsView").scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }

  function setView(view) {
    settings.view = view;
    saveSettings();
    stopPlay();
    trips = filterVia(allTrips);
    shown = PAGE_SIZE;
    renderList();
    renderRanking();
    drawBase();
    clearSelection();
  }

  function rerank() {
    saveSettings();
    rankRows = computeRanking();
    renderRanking();
    drawBase();
    fitOverview();
  }

  function togglePersonal(set, id) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    savePersonal();
    if (settings.rankBy === "favourites") rankRows = computeRanking();
    renderRanking();
    drawBase();
  }

  // ---------- Map drawing ----------

  // Curved line from a to b, bowing to the left of the direction of travel,
  // so an outbound and a return leg between the same cities don't overlap.
  function arc(a, b, bend = 0.18, steps = 72) {
    const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dx = (b.lon - a.lon) * k;
    const dy = b.lat - a.lat;
    const cLon = (a.lon + b.lon) / 2 - (dy * bend) / k;
    const cLat = (a.lat + b.lat) / 2 + dx * bend;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      pts.push([u * u * a.lat + 2 * u * t * cLat + t * t * b.lat, u * u * a.lon + 2 * u * t * cLon + t * t * b.lon]);
    }
    return pts;
  }

  function straight(a, b, steps = 20) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push([a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t]);
    }
    return pts;
  }

  function drawBase() {
    const home = stations.get(settings.home);
    layers.home.clearLayers();
    layers.overview.clearLayers();
    layers.stations.clearLayers();

    const ring = (km, color) =>
      L.circle([home.lat, home.lon], {
        pane: "areas",
        radius: km * 1000,
        color,
        weight: 1.5,
        dashArray: "6 6",
        fillColor: color,
        fillOpacity: 0.05,
        interactive: false,
      }).addTo(layers.home);
    if (!oneWay()) ring(settings.returnRadius, COLORS.back);
    if (settings.startRadius > 0) ring(settings.startRadius, COLORS.out);
    L.marker([home.lat, home.lon], { icon: homeIcon, keyboard: false, zIndexOffset: 500 })
      .bindTooltip(`Home: ${esc(home.name)}`, { direction: "top", offset: [0, -14] })
      .addTo(layers.home);

    if (settings.view === "destinations") {
      drawRankMarkers();
      return;
    }

    // Faint lines for every route used by the current trips.
    const routes = new Map();
    for (const t of trips) {
      t.legs.forEach((r, i) => {
        const kind = legKind(t, i);
        routes.set(`${kind}${r.from}-${r.to}`, [r.from, r.to, COLORS[kind]]);
      });
    }
    for (const [from, to, color] of routes.values()) {
      L.polyline(arc(stations.get(from), stations.get(to)), {
        pane: "overview",
        color,
        weight: 2,
        opacity: 0.35,
        interactive: false,
        className: "overview-line",
      }).addTo(layers.overview);
    }

    const viaCounts = new Map();
    for (const t of allTrips) {
      for (const id of stopsOf(t)) viaCounts.set(id, (viaCounts.get(id) || 0) + 1);
    }

    const hidden = new Set(settings.hideProviders);
    for (const s of stations.values()) {
      if (hidden.has(providerById.get(s.id))) continue;
      const km = M.haversineKm(home, s);
      const role = km <= settings.startRadius ? "out" : !oneWay() && km <= settings.returnRadius ? "back" : "far";
      const n = viaCounts.get(s.id) || 0;
      const marker = L.circleMarker([s.lat, s.lon], {
        pane: "stations",
        radius: n ? 6 + Math.min(5, Math.sqrt(n)) : 4.5,
        color: COLORS.panel,
        weight: 1.5,
        fillColor: n ? COLORS.out : COLORS[role],
        fillOpacity: n || role !== "far" ? 0.95 : 0.6,
      });
      const where = role === "out" ? "Start area" : role === "back" ? "Return area" : fmtKm(km) + " from home";
      const tripsLine = n ? `<br>${plural(n, tripWord())} ${viaWord()} ${esc(s.name)}${via === s.id ? " (filtered)" : ""}` : "";
      const source = providersInData.length > 1 ? ` · ${esc(providerName(providerById.get(s.id)))}` : "";
      marker.bindTooltip(
        `<strong>${esc(s.name)}</strong>${source}<br>${where}${tripsLine}<br><span class="tip-hint">Click for options</span>`,
        { direction: "top", offset: [0, -6] }
      );
      marker.bindPopup(() => stationMenu(s, n), { closeButton: false, className: "station-popup", offset: [0, -4] });
      marker.on("popupopen", () => marker.getTooltip().setOpacity(0)); // the menu says it all
      marker.on("popupclose", () => marker.getTooltip().setOpacity(0.9));
      marker.addTo(layers.stations);
    }
  }

  // "about 9 °C highs, 2.1 h of sun a day, 8 rainy days" for one month of climate data.
  function monthWeather(w) {
    const parts = [];
    if (w.t !== null) parts.push(`about ${Math.round(w.t)} °C highs`);
    if (w.sun !== null) parts.push(`${w.sun} h of sun a day`);
    if (w.rain !== null) parts.push(plural(Math.round(w.rain), "rainy day"));
    return parts.join(", ");
  }

  // The months (0-11) the date filters cover, in order, to mark them in the weather strip.
  function filterMonths() {
    const out = new Set();
    if (!settings.earliest || !settings.latest) return out;
    let [y, m] = settings.earliest.split("-").map(Number);
    const [lastY, lastM] = settings.latest.split("-").map(Number);
    while (out.size < 12 && (y < lastY || (y === lastY && m <= lastM))) {
      out.add(m - 1);
      if (m === 12) [y, m] = [y + 1, 1];
      else m++;
    }
    return out;
  }

  // Twelve bars of typical daytime highs for the station menu, with the months of your dates marked.
  function weatherStripHtml(s) {
    const months = climateData && climateData.stations[String(s.id)];
    const temps = months ? months.map((w) => w.t).filter((t) => t !== null) : [];
    if (!temps.length) return "";
    const lo = Math.min(0, ...temps);
    const hi = Math.max(30, ...temps); // one scale for most stations, so bars compare between them
    const marked = filterMonths();
    const bars = months
      .map((w, i) => {
        const h = w.t === null ? 0 : 3 + Math.round(((w.t - lo) / (hi - lo)) * 37);
        return `<i class="${marked.has(i) ? "on" : ""}" style="height:${h}px" title="${MONTHS[i]}: ${esc(monthWeather(w))}"></i>`;
      })
      .join("");
    const first = [...marked][0];
    return (
      '<div class="wx">' +
      `<div class="wx-bars" aria-hidden="true">${bars}</div>` +
      `<div class="wx-months" aria-hidden="true">${MONTHS.map((m) => `<span>${m[0]}</span>`).join("")}</div>` +
      (first !== undefined ? `<p class="wx-note">${MONTHS[first]}: ${esc(monthWeather(months[first]))}</p>` : "") +
      `<p class="wx-credit">Typical highs, ${esc(climateData.period)} average, your dates marked · ` +
      '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a></p>' +
      "</div>"
    );
  }

  // The menu a click on a station opens: make it the home station, or list only the trips that stop there.
  function stationMenu(s, viaCount) {
    const target = homeFor(s);
    const count = homeCounts.get(target.id);
    const asHome = count === undefined ? "counting…" : plural(count, tripWord());
    const source = providersInData.length > 1 ? ` · ${esc(providerName(providerById.get(s.id)))}` : "";
    const lines = [`<p><strong>${esc(s.name)}</strong>${source}</p>`];
    lines.push(weatherStripHtml(s));
    if (target.id === settings.home) {
      lines.push("<p>Your home station</p>");
    } else {
      const who = target.id === s.id ? "As home" : `${esc(target.name)} as home`;
      lines.push(`<p>${who}: ${asHome}</p>`);
      lines.push(`<button type="button" data-action="home">Set ${target.id === s.id ? "" : esc(target.name) + " "}as home</button>`);
    }
    if (via === s.id) lines.push('<button type="button" data-action="via">Show all trips again</button>');
    else if (viaCount) lines.push(`<button type="button" data-action="via">Trips ${viaWord()} ${esc(s.name)} (${viaCount})</button>`);

    const el = document.createElement("div");
    el.className = "station-menu";
    el.innerHTML = lines.join("");
    el.addEventListener("click", (e) => {
      const action = e.target.closest("button")?.dataset.action;
      if (!action) return;
      map.closePopup();
      if (action === "home") setHome(target.id);
      else setVia(via === s.id ? null : s.id);
    });
    return el;
  }

  function fitOverview() {
    const home = stations.get(settings.home);
    // Around home: the return area, or for one-way trips the region nearby (their stops widen it).
    const reachKm = oneWay() ? Math.max(settings.startRadius, 100) : settings.returnRadius;
    const bounds = L.latLng(home.lat, home.lon).toBounds(reachKm * 2000);
    const ids =
      settings.view === "destinations"
        ? visibleRankRows().filter((r) => r.rank !== null).slice(0, 15).map((r) => r.id)
        : trips.flatMap((t) => [...stopsOf(t)]);
    for (const id of ids) {
      const s = stations.get(id);
      bounds.extend([s.lat, s.lon]);
    }
    map.fitBounds(bounds, {
      paddingTopLeft: [40 + mapInsetLeft, 40],
      paddingBottomRight: [40, 40],
      maxZoom: 8,
      animate: !reduceMotion,
    });
  }

  function runLeg(line, van, pts, duration, token) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        if (token !== animToken) return resolve(false);
        const p = Math.min(1, (now - t0) / duration);
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const i = Math.max(1, Math.round(eased * (pts.length - 1)));
        line.setLatLngs(pts.slice(0, i + 1));
        van.setLatLng(pts[i]);
        if (p < 1) requestAnimationFrame(frame);
        else resolve(true);
      }
      requestAnimationFrame(frame);
    });
  }

  function stopMarker(s, color, label) {
    L.circleMarker([s.lat, s.lon], { pane: "trip", radius: 7, color: COLORS.panel, weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(label, { permanent: true, direction: "auto", className: "stop-label", offset: [8, 0] })
      .addTo(layers.trip);
  }

  // The national parks and World Heritage sites the selected trip passes (within 10 km of the road).
  function drawSites(t) {
    const f = facts.get(t.id);
    const sites = f ? f.sites : [];
    for (const s of sites) {
      L.marker([s.lat, s.lon], { pane: "sites", icon: SITE_ICONS[s.kind], keyboard: false })
        .bindTooltip(`<strong>${esc(s.name)}</strong><br>${SITE_KINDS[s.kind]}`, { direction: "top", offset: [0, -6] })
        .addTo(layers.trip);
    }
    showSiteLegend(sites);
  }

  function showSiteLegend(sites) {
    $("legendParks").hidden = !sites.some((s) => s.kind === "park");
    $("legendHeritage").hidden = !sites.some((s) => s.kind === "unesco");
  }

  // Draws the selected trip and animates a van along it. Resolves when the animation ends.
  async function drawTrip(t, animate) {
    const token = ++animToken;
    layers.trip.clearLayers();
    map.getContainer().classList.add("dimmed");

    const n = t.legs.length;
    const at = (id) => stations.get(id);
    const legMs = n === 3 ? 1900 : 2200;
    const legs = []; // drawn segments: the rallies plus any train hops between them
    t.legs.forEach((r, i) => {
      if (i > 0 && r.from !== t.legs[i - 1].to) {
        legs.push({ kind: "hop", pts: straight(at(t.legs[i - 1].to), at(r.from)), ms: 700 });
      }
      legs.push({ kind: legKind(t, i), pts: arc(at(r.from), at(r.to)), ms: legMs });
    });

    const bounds = L.latLngBounds(legs.flatMap((l) => l.pts));
    if (settings.wayHome) bounds.extend([homeDest().lat, homeDest().lon]);
    map.fitBounds(bounds, {
      paddingTopLeft: [60, 80], // clear of the buttons
      paddingBottomRight: [60, 80], // and the legend
      maxZoom: 7,
      animate: animate && !reduceMotion,
    });

    const still = !animate || reduceMotion;
    const lines = legs.map((l) =>
      L.polyline(still ? l.pts : [l.pts[0]], {
        pane: "trip",
        color: COLORS[l.kind],
        weight: l.kind === "hop" ? 3 : 4.5,
        dashArray: l.kind === "hop" ? "1 7" : null,
        lineCap: "round",
        interactive: false,
        className: "trip-line",
      }).addTo(layers.trip)
    );

    const start = at(t.legs[0].from);
    stopMarker(start, COLORS.out, `${esc(start.name)} · ${fmtDay(t.legs[0].pickup)}`);
    for (let i = 0; i < n - 1; i++) {
      const prev = t.legs[i];
      const next = t.legs[i + 1];
      const arriveColor = COLORS[legKind(t, i)];
      const arrive = `${esc(at(prev.to).name)} · ${fmtDay(prev.return)}`;
      if (next.from !== prev.to) {
        stopMarker(at(prev.to), arriveColor, arrive);
        stopMarker(at(next.from), COLORS[legKind(t, i + 1)], `${esc(at(next.from).name)} · ${fmtDay(next.pickup)}`);
      } else {
        stopMarker(at(prev.to), arriveColor, arrive + (t.waits[i] ? ` → ${fmtDay(next.pickup)}` : ""));
      }
    }
    const end = t.legs[n - 1];
    stopMarker(at(end.to), COLORS[legKind(t, n - 1)], `${esc(at(end.to).name)} · ${fmtDay(end.return)}`);
    drawSites(t);

    const flow = (line, kind) => {
      if (kind !== "hop") line.getElement()?.classList.add("flow");
    };

    const lastPts = legs[legs.length - 1].pts;
    const van = L.marker(still ? lastPts[lastPts.length - 1] : legs[0].pts[0], {
      icon: vanIcon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(layers.trip);

    if (still) {
      legs.forEach((l, i) => flow(lines[i], l.kind));
      van.getElement()?.setAttribute("data-leg", legKind(t, n - 1));
      return;
    }

    await sleep(450); // let the map finish moving first
    for (let i = 0; i < legs.length; i++) {
      if (token !== animToken) return;
      van.getElement()?.setAttribute("data-leg", legs[i].kind);
      const done = await runLeg(lines[i], van, legs[i].pts, legs[i].ms, token);
      if (!done) return;
      flow(lines[i], legs[i].kind);
      await sleep(350);
    }
  }

  // ---------- Way home ----------

  const lastLeg = (t) => t.legs[t.legs.length - 1];
  // The way home ends at the home city's central station, not at the rental depot.
  function homeDest() {
    return W.homePoint(stations.get(settings.home), window.CityCenters);
  }
  const driveKey = (a, b) => `${a.lat},${a.lon};${b.lat},${b.lon}`;
  const driveResults = new Map(); // driveKey -> { km, min, path } or { error: true }
  const driveRequests = new Map();

  // Driving route from the free OSRM demo server: one request per trip, only when it's selected.
  function loadDrive(a, b) {
    const key = driveKey(a, b);
    if (driveRequests.has(key)) return driveRequests.get(key);
    const url =
      `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}` +
      "?overview=simplified&geometries=geojson";
    const request = fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const route = j.routes && j.routes[0];
        if (j.code !== "Ok" || !route) throw new Error(j.code || "no route");
        driveResults.set(key, {
          km: route.distance / 1000,
          min: route.duration / 60,
          path: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        });
      })
      .catch(() => driveResults.set(key, { error: true }))
      .finally(() => driveRequests.delete(key));
    driveRequests.set(key, request);
    return request;
  }

  // Live train and bus connections from Transitous, fetched through serve.py (which adds the contact).
  const transitKey = (a, b, iso) => `${a.lat},${a.lon};${b.lat},${b.lon};${iso}`;
  const transitResults = new Map(); // transitKey -> { options: [{ ...summary, legs }] } or { error, reason }
  const transitRequests = new Map();
  const itineraryChoice = new Map(); // transitKey -> index of the connection shown on the map

  function loadTransit(a, b, iso) {
    const key = transitKey(a, b, iso);
    if (transitRequests.has(key)) return transitRequests.get(key);
    if (location.protocol === "file:") {
      transitResults.set(key, { error: true, reason: "no-server" });
      return Promise.resolve();
    }
    const url = `api/transit?from=${a.lat},${a.lon}&to=${b.lat},${b.lon}&time=${encodeURIComponent(iso)}`;
    const request = fetch(url)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          transitResults.set(key, { error: true, reason: body.error || "no-server" });
          return;
        }
        const options = (body.itineraries || []).slice(0, 5).map((it) => ({ ...W.summarizeItinerary(it), legs: it.legs }));
        transitResults.set(key, { options });
      })
      .catch(() => transitResults.set(key, { error: true, reason: "upstream" }))
      .finally(() => transitRequests.delete(key));
    transitRequests.set(key, request);
    return request;
  }

  function fmtClock(iso, timeZone) {
    const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try {
      return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timeZone || undefined }).format(new Date(iso));
    } catch (e) {
      return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso)); // unknown time zone name
    }
  }

  const localDay = (iso, timeZone) => {
    try {
      return new Date(iso).toLocaleDateString("en-CA", { timeZone: timeZone || undefined });
    } catch (e) {
      return new Date(iso).toLocaleDateString("en-CA");
    }
  };

  const extLink = (url, text) => `<a class="book" href="${url}" target="_blank" rel="noopener">${text} ↗</a>`;

  const TRANSIT_TROUBLE = {
    "no-server": "Live times need the local server, so open the site with open-site.bat.",
    "no-contact": "Live times need your contact in config.local.json (see the README).",
    limit: "Today's limit for live lookups is used up.",
    upstream: "The timetable service didn't answer.",
  };

  function transitHtml(end, home, est, live, chosen) {
    const mapsLink = extLink(W.googleMapsUrl(end, home, "transit"), "Google Maps");
    const estimate = `About ${fmtRange(est.lowMin, est.highMin)} by train or bus`;
    if (!live) return '<p class="wh-main">Looking up connections…</p>';
    if (live.error || !live.options.length) {
      const why = live.error ? TRANSIT_TROUBLE[live.reason] || TRANSIT_TROUBLE.upstream : "No connections found for that afternoon.";
      const retry = live.error && live.reason === "upstream"
        ? '<button type="button" class="wh-retry" data-mode="transit" data-retry="1">Try again</button>'
        : "";
      return (
        `<p class="wh-main">${estimate}</p>` +
        `<p class="wh-detail">${why} The time is a rough estimate from the distance.</p>` +
        `<div class="wh-links">${retry}${mapsLink}</div>`
      );
    }

    const fastest = W.fastestIndex(live.options);
    const rows = live.options.map((o, i) => {
      const nextDay = localDay(o.end, o.endTz) !== localDay(o.start, o.startTz) ? " +1" : "";
      const changes = o.transfers === 0 ? "direct" : plural(o.transfers, "change");
      return (
        `<li><button type="button" class="wh-option" data-itinerary="${i}" aria-pressed="${i === chosen}">` +
        `<span class="wh-times">${fmtClock(o.start, o.startTz)} → ${fmtClock(o.end, o.endTz)}${nextDay}` +
        `${i === fastest ? '<span class="wh-tag">Fastest</span>' : ""}</span>` +
        `<span class="wh-dur">${fmtDuration(o.durationMin)} · ${changes}</span>` +
        `<span class="wh-lines">${o.lines.map(esc).join(" · ")}</span>` +
        "</button></li>"
      );
    });
    return (
      `<p class="wh-main">Connections after ${esc(settings.dropoffTime)}</p>` +
      `<ol class="wh-options">${rows.join("")}</ol>` +
      '<p class="wh-detail">Pick one to see it on the map. Book the tickets with the train or bus company.</p>' +
      `<div class="wh-links">${mapsLink}</div>` +
      '<p class="wh-credit">Times by <a href="https://transitous.org/" target="_blank" rel="noopener">Transitous</a> · ' +
      '<a href="https://transitous.org/sources/" target="_blank" rel="noopener">data sources</a></p>'
    );
  }

  function carHtml(end, home, drive) {
    const mapsLink = extLink(W.googleMapsUrl(end, home, "driving"), "Route in Google Maps");
    if (!drive) return '<p class="wh-main">Working out the route…</p>';
    if (drive.error) {
      return (
        "<p class=\"wh-main\">The route didn't load</p>" +
        "<p class=\"wh-detail\">The free routing service didn't answer.</p>" +
        `<div class="wh-links"><button type="button" class="wh-retry" data-mode="car" data-retry="1">Try again</button>${mapsLink}</div>`
      );
    }
    const cost = W.fuelCost(drive.km, settings.carConsumption, settings.fuelPrice);
    return (
      `<p class="wh-main">${fmtKm(drive.km)} · ${fmtDuration(drive.min)}</p>` +
      `<p class="wh-detail">Driving time without traffic or breaks. Fuel about €${Math.round(cost)} ` +
      `at ${settings.carConsumption} l/100 km and €${settings.fuelPrice.toFixed(2)}/l. Needs a lift or a one-way rental car.</p>` +
      `<div class="wh-links">${mapsLink}</div>` +
      '<p class="wh-credit">Route by OSRM, © OpenStreetMap contributors</p>'
    );
  }

  function drawWayHome(mode, end, home, drive, connection) {
    const at = (p) => [p.lat, p.lon];
    const line = (pts, dashArray, weight = 3) =>
      L.polyline(pts, { pane: "wayhome", color: COLORS.ink, weight, opacity: 0.75, dashArray, lineCap: "round", interactive: false })
        .addTo(layers.wayHome);

    if (mode === "transit" && connection) {
      for (const leg of connection.legs) {
        const geo = leg.legGeometry;
        const pts = geo && geo.points ? W.decodePolyline(geo.points, geo.precision || 6) : [at(leg.from), at(leg.to)];
        if (leg.mode === "WALK") line(pts, "1 5", 2);
        else line(pts, "8 6");
      }
    } else if (mode === "car" && drive && !drive.error) {
      line(drive.path, "8 6");
    } else {
      line([at(end), at(home)], "1 6", 2.5);
    }
  }

  // Fills the way-home panel of the selected trip and draws the chosen way on the map.
  function renderWayHome(t) {
    layers.wayHome.clearLayers();
    const panel = $("results").querySelector(".trip.selected .wayhome");
    if (!settings.wayHome || !panel) return;

    const end = stations.get(lastLeg(t).to);
    const home = homeDest();
    const crowKm = M.haversineKm(end, home);
    if (crowKm < 3 || M.haversineKm(end, stations.get(settings.home)) < 3) {
      panel.innerHTML = "<p class=\"wh-detail\">The last van goes back to your home station, so you're home already.</p>";
      return;
    }

    const drive = driveResults.get(driveKey(end, home)) || null;
    if (!drive) {
      loadDrive(end, home).then(() => {
        if (selectedId === t.id) renderWayHome(t);
      });
    }
    const date = lastLeg(t).return;
    const leaveAfter = new Date(`${date}T${settings.dropoffTime}:00`).toISOString(); // your local time
    const tKey = transitKey(end, home, leaveAfter);
    const live = transitResults.get(tKey) || null;
    if (!live) {
      loadTransit(end, home, leaveAfter).then(() => {
        if (selectedId === t.id) renderWayHome(t);
      });
    }
    const liveOk = live && !live.error && live.options.length > 0;
    if (liveOk && !itineraryChoice.has(tKey)) itineraryChoice.set(tKey, W.fastestIndex(live.options));
    const chosen = liveOk ? itineraryChoice.get(tKey) : -1;

    const transit = W.transitEstimate(end, home);
    const mode = settings.homeMode;

    const tab = (m, label, summary) =>
      `<button type="button" role="tab" class="wh-tab" data-mode="${m}" aria-selected="${m === mode}">${label}<span>${summary}</span></button>`;
    const body = mode === "car" ? carHtml(end, home, drive) : transitHtml(end, home, transit, live, chosen);
    const transitSummary = !live
      ? "…"
      : liveOk ? fmtDuration(live.options[W.fastestIndex(live.options)].durationMin) : fmtRange(transit.lowMin, transit.highMin);

    panel.innerHTML =
      `<h4>Getting home from ${esc(end.name)}</h4>` +
      `<p class="wh-sub">${fmtDay(date)} · ${fmtKm(crowKm)} to ${esc(home.name)} as the crow flies</p>` +
      '<div class="wh-tabs" role="tablist" aria-label="How to get home">' +
      tab("transit", "Train & bus", transitSummary) +
      tab("car", "Car", !drive ? "…" : drive.error ? "–" : fmtDuration(drive.min)) +
      "</div>" +
      `<div class="wh-body" role="tabpanel">${body}</div>`;
    drawWayHome(mode, end, home, drive, liveOk ? live.options[chosen] : null);
  }

  function chooseItinerary(index) {
    const t = trips.find((x) => x.id === selectedId);
    if (!t) return;
    const leaveAfter = new Date(`${lastLeg(t).return}T${settings.dropoffTime}:00`).toISOString();
    itineraryChoice.set(transitKey(stations.get(lastLeg(t).to), homeDest(), leaveAfter), index);
    renderWayHome(t);
    $("results").querySelector(`.wh-option[data-itinerary="${index}"]`)?.focus();
  }

  // Puts "Along the way" and an empty way-home panel into the selected card (re-rendering the list drops them).
  function attachPanels(t) {
    for (const panel of $("results").querySelectorAll(".along, .wayhome")) panel.remove();
    const el = $("results").querySelector(".trip.selected");
    if (el) el.insertAdjacentHTML("beforeend", alongHtml(t));
    if (el && settings.wayHome) el.insertAdjacentHTML("beforeend", '<section class="wayhome" aria-label="Getting home"></section>');
    renderWayHome(t);
  }

  // ---------- Along the way ----------

  // Parks and World Heritage sites were only looked up in Europe.
  const NO_SITE_LOOKUP = new Set(["US", "CA", "MX"]);
  // "A, B, C, D, +14 more", where a click on "+14 more" shows the rest.
  const nameList = (names, max = 4) =>
    names.length <= max + 1
      ? esc(names.join(", "))
      : esc(names.slice(0, max).join(", ")) +
        `<button type="button" class="more-names" data-more>, +${names.length - max} more</button>` +
        `<span hidden>, ${esc(names.slice(max).join(", "))}</span>`;

  function alongLegHtml(leg, kind, a, b) {
    const main = leg.measured
      ? `${fmtKm(leg.km)}${leg.drivingMin !== null ? ` · about ${fmtDuration(leg.drivingMin)} driving` : ""}`
      : `about ${fmtKm(leg.km)}, estimated`;
    const countries = leg.countries.length > 1 ? `<p class="along-detail">${esc(leg.countries.map(countryName).join(" → "))}</p>` : "";
    const details = [];
    if (!leg.measured) {
      details.push("Road, scenery and driving time come with the next data update");
    } else {
      if (leg.parks.length) details.push(`National parks: ${nameList(leg.parks)}`);
      if (leg.unesco.length) details.push(`World Heritage: ${nameList(leg.unesco)}`);
      if (leg.coastKm) details.push(`${fmtKm(leg.coastKm)} by the sea`);
      if (leg.mountainKm) details.push(`${fmtKm(leg.mountainKm)} above 1,000 m`);
      if (leg.maxElevation !== null) details.push(`highest point ${leg.maxElevation.toLocaleString("en-GB")} m`);
      if (NO_SITE_LOOKUP.has(a.country) || NO_SITE_LOOKUP.has(b.country)) {
        details.push("parks and World Heritage sites are only looked up in Europe");
      } else if (!leg.parks.length && !leg.unesco.length && !leg.coastKm && !leg.mountainKm) {
        details.push("no national parks, World Heritage sites, coast or mountains near the road");
      }
    }
    return (
      `<li class="along-leg ${kind}">` +
      `<p class="along-main">${esc(a.name)} → ${esc(b.name)} · ${main}</p>` +
      countries +
      `<p class="along-detail">${details.join(" · ")}</p>` +
      "</li>"
    );
  }

  // The weather where you stop between rallies, for the month you arrive.
  function alongStopHtml(s, arrive, leave) {
    const w = R.weatherFor(climateData, s.id, arrive);
    const text = w && monthWeather(w)
      ? `${monthWeather(w)} in ${MONTHS[w.month]} (${esc(climateData.period)} average)`
      : "No weather data for this station yet";
    const when = leave && leave !== arrive ? `${fmtDay(arrive)} – ${fmtDay(leave)}` : fmtDay(arrive);
    return (
      '<li class="along-stop">' +
      `<p class="along-main">${esc(s.name)}, ${when}</p>` +
      `<p class="along-detail">${text[0].toUpperCase()}${text.slice(1)}</p>` +
      "</li>"
    );
  }

  function alongHtml(t) {
    const f = facts.get(t.id);
    if (!f) return "";
    const n = t.legs.length;
    const items = [];
    t.legs.forEach((r, i) => {
      items.push(alongLegHtml(f.legs[i], legKind(t, i), stations.get(r.from), stations.get(r.to)));
      if (i < n - 1) items.push(alongStopHtml(stations.get(r.to), r.return, t.legs[i + 1].pickup));
    });
    // A one-way trip ends somewhere new, so the weather you arrive to is worth a line as well.
    if (t.type === "oneway") items.push(alongStopHtml(stations.get(lastLeg(t).to), lastLeg(t).return, null));
    const summary =
      f.drivingMinPerDay !== null
        ? `<p class="wh-detail">About ${fmtDuration(f.drivingMinPerDay)} driving a day on average, ${fmtDuration(f.drivingMin)} in all.</p>`
        : "";
    const credits = [
      routeData && '<a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> (roads), Wikidata (national parks), OpenStreetMap (World Heritage sites)',
      climateData && '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (weather)',
    ].filter(Boolean);
    return (
      '<section class="along" aria-label="Along the way">' +
      "<h4>Along the way</h4>" +
      `<ol class="along-list">${items.join("")}</ol>` +
      summary +
      (credits.length ? `<p class="wh-credit">Sources: ${credits.join(", ")}</p>` : "") +
      "</section>"
    );
  }

  function setHomeMode(mode, retry) {
    const t = trips.find((x) => x.id === selectedId);
    if (!t || !HOME_MODES.includes(mode)) return;
    if (retry) {
      const end = stations.get(lastLeg(t).to);
      const home = homeDest();
      driveResults.delete(driveKey(end, home));
      transitResults.delete(transitKey(end, home, new Date(`${lastLeg(t).return}T${settings.dropoffTime}:00`).toISOString()));
    }
    settings.homeMode = mode;
    saveSettings();
    renderWayHome(t);
    $("results").querySelector(`.wh-tab[data-mode="${mode}"]`)?.focus(); // keep keyboard focus on the tabs
  }

  // ---------- Selection and playback ----------

  function selectTrip(id, { animate = true, scroll = false, fromPlay = false } = {}) {
    if (!fromPlay) stopPlay();
    const t = trips.find((x) => x.id === id);
    if (!t) return Promise.resolve();
    selectedId = id;
    for (const el of $("results").querySelectorAll(".trip.selected")) el.classList.remove("selected");
    const el = $("results").querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add("selected");
    attachPanels(t);
    if (el && scroll) el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    $("overview").hidden = false;
    return drawTrip(t, animate);
  }

  function clearSelection() {
    selectedId = null;
    animToken++;
    layers.trip.clearLayers();
    layers.wayHome.clearLayers();
    for (const panel of $("results").querySelectorAll(".along, .wayhome")) panel.remove();
    showSiteLegend([]);
    map.getContainer().classList.remove("dimmed");
    for (const el of $("results").querySelectorAll(".trip.selected")) el.classList.remove("selected");
    $("overview").hidden = true;
    fitOverview();
  }

  function updatePlayButton() {
    $("playAll").textContent = playing ? "Pause" : "Play all";
    $("playAll").setAttribute("aria-pressed", String(playing));
  }

  async function startPlay() {
    const list = trips.slice(0, shown);
    if (!list.length) return;
    const token = ++playToken;
    playing = true;
    updatePlayButton();
    let i = Math.max(0, list.findIndex((t) => t.id === selectedId));
    while (token === playToken) {
      await selectTrip(list[i % list.length].id, { scroll: true, fromPlay: true });
      await sleep(reduceMotion ? 2500 : 1400);
      i++;
    }
  }

  function stopPlay() {
    if (!playing) return;
    playing = false;
    playToken++;
    updatePlayButton();
  }

  // ---------- Events ----------

  $("filters").addEventListener("input", onFilterChange);
  $("filters").addEventListener("change", onFilterChange);
  $("sort").addEventListener("change", onFilterChange);

  $("results").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const modeButton = e.target.closest("[data-mode]");
    if (modeButton) {
      setHomeMode(modeButton.dataset.mode, Boolean(modeButton.dataset.retry));
      return;
    }
    const option = e.target.closest("[data-itinerary]");
    if (option) {
      chooseItinerary(Number(option.dataset.itinerary));
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      more.nextElementSibling.hidden = false;
      more.remove();
      return;
    }
    if (e.target.closest(".wayhome, .along")) return;
    if (e.target.closest("#showMore")) {
      shown += PAGE_SIZE;
      renderList();
      const t = trips.find((x) => x.id === selectedId);
      if (t) attachPanels(t);
      return;
    }
    const li = e.target.closest(".trip");
    if (li) selectTrip(li.dataset.id);
  });

  $("results").addEventListener("keydown", (e) => {
    const li = e.target.closest(".trip");
    if (li && e.target === li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      selectTrip(li.dataset.id);
    }
  });

  $("viaChip").addEventListener("click", (e) => {
    if (e.target.closest("#clearVia")) setVia(null);
  });

  for (const el of document.querySelectorAll('input[name="view"]')) {
    el.addEventListener("change", () => setView(el.value));
  }
  for (const el of document.querySelectorAll('input[name="rankMode"]')) {
    el.addEventListener("change", () => {
      settings.rankMode = el.value;
      rerank();
    });
  }
  $("rankBy").addEventListener("change", () => {
    settings.rankBy = $("rankBy").value;
    rerank();
  });
  $("combineChips").addEventListener("change", () => {
    settings.combine = [...$("combineChips").querySelectorAll("input:checked")].map((el) => el.value);
    rerank();
  });
  for (const id of ["onlyFavs", "hideVisited"]) {
    $(id).addEventListener("change", () => {
      settings[id] = $(id).checked;
      saveSettings();
      renderRanking();
      drawBase();
    });
  }

  $("ranking").addEventListener("click", (e) => {
    const row = e.target.closest(".rank-row");
    if (!row) return;
    const id = stationById.get(row.dataset.station);
    if (e.target.closest("[data-fav]")) togglePersonal(personal.fav, id);
    else if (e.target.closest("[data-visited]")) togglePersonal(personal.visited, id);
    else openStation(id);
  });
  $("ranking").addEventListener("keydown", (e) => {
    const row = e.target.closest(".rank-row");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openStation(stationById.get(row.dataset.station));
    }
  });

  $("playAll").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  $("overview").addEventListener("click", () => {
    stopPlay();
    clearSelection();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selectedId) {
      stopPlay();
      clearSelection();
    }
  });

  // ---------- Landing page ----------

  // On a first visit the panel is a card over a full-window map (see style.css) that asks for home,
  // dates and the kind of trip. Behind it the map previews the choice: it moves the chosen home into
  // the free space beside the card and plays rallies that start there.

  const DEMO_START_KM = 50; // rallies starting this close to home count as "from home"
  let demoGroup = null; // what the running round of the preview has drawn
  let demoHome = null;

  const pickSome = (list, n) => [...list].sort(() => Math.random() - 0.5).slice(0, n);

  // Where the rallies from around `home` go: station ids, without home itself.
  function demoDestinations(home) {
    const near = new Set(
      [...stations.values()].filter((s) => M.haversineKm(home, s) <= DEMO_START_KM).map((s) => s.id)
    );
    const to = new Set();
    for (const r of data.rallies) if (near.has(r.from) && !near.has(r.to) && stations.has(r.to)) to.add(r.to);
    return [...to];
  }

  // A ring that spreads from a station and fades (style.css: .demo-pulse).
  function demoPulse(group, s, color) {
    const ring = L.circleMarker([s.lat, s.lon], {
      pane: "trip", radius: 6, color, weight: 2, fill: false, interactive: false, className: "demo-pulse",
    }).addTo(group);
    setTimeout(() => group.removeLayer(ring), 950);
  }

  // Draws a rally from its first point to its last, led by a bright dot; the destination then lights up.
  function demoLine(group, from, to, kind, delay, token) {
    const pts = arc(stations.get(from), stations.get(to));
    const end = stations.get(to);
    const line = L.polyline(reduceMotion ? pts : [pts[0], pts[0]], {
      pane: "trip", color: COLORS[kind], weight: 4, opacity: 0.95, lineCap: "round", interactive: false,
    }).addTo(group);
    const arrive = () => {
      L.circleMarker([end.lat, end.lon], {
        pane: "trip", radius: 6, color: COLORS.panel, weight: 2, fillColor: COLORS[kind], fillOpacity: 1, interactive: false,
      }).addTo(group);
      if (!reduceMotion) demoPulse(group, end, COLORS[kind]);
    };
    if (reduceMotion) return Promise.resolve(arrive());
    return sleep(delay).then(
      () =>
        new Promise((resolve) => {
          if (token !== demoToken) return resolve();
          const head = L.circleMarker(pts[0], {
            pane: "trip", radius: 5, color: COLORS[kind], weight: 2, fillColor: COLORS.panel, fillOpacity: 1, interactive: false,
          }).addTo(group);
          const start = performance.now();
          const ms = 1100;
          // A timer, not animation frames: those stop while the window is covered, and the loop would hang.
          const step = () => {
            if (token !== demoToken) return resolve();
            const t = Math.min(1, (performance.now() - start) / ms);
            const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
            const n = Math.max(2, Math.ceil(eased * pts.length));
            line.setLatLngs(pts.slice(0, n));
            head.setLatLng(pts[n - 1]);
            if (t < 1) return setTimeout(step, 16);
            group.removeLayer(head);
            arrive();
            resolve();
          };
          step();
        })
    );
  }

  // Moves the map so `bounds` fills the wider free side of the card (west of home: left, east: right).
  function demoFrame(bounds, west) {
    const card = document.querySelector(".panel").getBoundingClientRect();
    const size = map.getSize();
    const left = card.left;
    const right = size.x - card.right;
    const opts = { maxZoom: 7, paddingTopLeft: [40, 70], paddingBottomRight: [40, 70] };
    if (Math.max(left, right) >= 260 && size.y >= 360) {
      // Beside the card there is room: keep the routes out from behind it.
      if (west) opts.paddingBottomRight = [size.x - left + 30, 70];
      else opts.paddingTopLeft = [card.right + 30, 70];
    }
    if (reduceMotion) map.fitBounds(bounds, { ...opts, animate: false });
    else map.flyToBounds(bounds, { ...opts, duration: 1.3 });
    return reduceMotion ? Promise.resolve() : sleep(1400);
  }

  // Round after round for the chosen home: frame it, fan out some of its rallies, continue one of them
  // with an onward rally, hold, fade. Rounds alternate between the rallies going west and east.
  function playDemo() {
    const token = ++demoToken;
    // The map can fail mid-flight when the window is resized: start over rather than stand still.
    runDemo(token).catch(() => setTimeout(() => token === demoToken && playDemo(), 1500));
  }

  async function runDemo(token) {
    if (demoGroup) layers.demo.removeLayer(demoGroup);
    demoHome = homeById.get($("home").value);
    const home = stations.get(demoHome);
    const dests = demoDestinations(home);
    const sides = [dests.filter((id) => stations.get(id).lon < home.lon), dests.filter((id) => stations.get(id).lon >= home.lon)];
    let west = sides[0].length >= sides[1].length;

    while (token === demoToken) {
      const group = (demoGroup = L.layerGroup().addTo(layers.demo));
      const chosen = pickSome(sides[west ? 0 : 1], 4);
      const bounds = L.latLng(home.lat, home.lon).toBounds(150000);
      for (const id of chosen) bounds.extend([stations.get(id).lat, stations.get(id).lon]);
      await demoFrame(bounds, west);
      if (token !== demoToken) return;

      L.marker([home.lat, home.lon], { icon: homeIcon, pane: "trip", interactive: false, keyboard: false }).addTo(group);
      if (!reduceMotion) demoPulse(group, home, COLORS.ink);
      await Promise.all(chosen.map((to, i) => demoLine(group, demoHome, to, "out", 250 + i * 320, token)));
      if (token !== demoToken) return;

      // One onward rally from a destination, if it ends inside the picture and not behind the card.
      const size = map.getSize();
      const card = document.querySelector(".panel").getBoundingClientRect();
      const inView = (id) => {
        const p = map.latLngToContainerPoint([stations.get(id).lat, stations.get(id).lon]);
        const beside = p.x < card.left - 20 || p.x > card.right + 20 || p.y < card.top - 20 || p.y > card.bottom + 20;
        return beside && p.x > 30 && p.x < size.x - 30 && p.y > 30 && p.y < size.y - 30;
      };
      for (const stop of chosen) {
        const onward = demoDestinations(stations.get(stop)).filter((id) => id !== demoHome && !chosen.includes(id) && inView(id));
        if (!onward.length) continue;
        await demoLine(group, stop, pickSome(onward, 1)[0], "mid", 150, token);
        break;
      }
      if (reduceMotion || token !== demoToken) return; // without motion: one still picture
      await sleep(chosen.length ? 2400 : 4000);
      if (token !== demoToken) return;
      group.eachLayer((l) => l.getElement() && l.getElement().classList.add("demo-fade"));
      await sleep(650);
      layers.demo.removeLayer(group);
      if (sides[west ? 1 : 0].length) west = !west;
    }
  }

  function startLanding() {
    const total = [...offers.values()].reduce((n, set) => n + set.size, 0);
    $("landingStats").textContent =
      `${total.toLocaleString("en-GB")} ${total === 1 ? "rally" : "rallies"} · ` +
      `${stations.size.toLocaleString("en-GB")} stations · updated ${when}`;
    for (const s of stations.values()) {
      L.circleMarker([s.lat, s.lon], {
        pane: "stations", radius: 4, color: COLORS.panel, weight: 1.5, fillColor: COLORS.far, fillOpacity: 1, interactive: false,
      }).addTo(layers.demo);
    }
    playDemo();
  }

  // "Show trips": keep the choices, then slide the card to where the panel belongs.
  function leaveLanding() {
    if (!landing) return;
    readForm();
    const error = dateError();
    $("dateError").textContent = error;
    if (error) return;
    landing = false;
    demoToken++;
    map.stop(); // the preview may be mid-flight
    layers.demo.clearLayers();
    saveSettings();

    const root = document.documentElement;
    const panel = document.querySelector(".panel");
    if (reduceMotion || !window.matchMedia("(min-width: 821px)").matches) {
      // Narrow windows stack map and panel, so there is nowhere to slide to.
      root.classList.remove("landing");
      map.invalidateSize();
      compute();
      return;
    }

    const from = panel.getBoundingClientRect();
    const px = (n) => `${n}px`;
    Object.assign(panel.style, {
      left: px(from.left), top: px(from.top), width: px(from.width), height: px(from.height), transform: "none", maxHeight: "none",
    });
    root.classList.replace("landing", "landing-leave");
    void panel.offsetWidth; // start the slide from the card's place
    mapInsetLeft = 410; // the panel's width in the two-column layout (.app in style.css)
    Object.assign(panel.style, { left: "0px", top: "0px", width: px(mapInsetLeft), height: px(window.innerHeight) });
    compute(); // the map is still full-window: fitOverview leaves room for the panel

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.classList.remove("landing-leave");
      panel.removeAttribute("style");
      // The map shrinks to the right of the panel; keep what it shows where it is.
      map.invalidateSize({ pan: false });
      map.panBy([mapInsetLeft, 0], { animate: false });
      mapInsetLeft = 0;
    };
    panel.addEventListener("transitionend", (e) => {
      if (e.target === panel && e.propertyName === "width") finish();
    });
    setTimeout(finish, 1200);
  }

  $("landingGo").addEventListener("click", leaveLanding);

  // ---------- Start ----------

  // Data saved before Imoova was added has one fetched_at and no sources.
  const sources = data.sources || { roadsurfer: { fetched_at: data.fetched_at } };
  const offers = new Map(); // provider -> distinct offers (one Imoova relocation covers many pickup days)
  for (const r of data.rallies) {
    const p = providerOf(r);
    if (!offers.has(p)) offers.set(p, new Set());
    offers.get(p).add(r.ref ?? `${r.from}-${r.to}-${r.pickup}`);
  }
  const counts = providersInData.map((p) => {
    const n = offers.get(p).size.toLocaleString("en-GB");
    return PROVIDERS[p] ? `${n} ${PROVIDERS[p].name} ${PROVIDERS[p].unit}` : `${n} from ${esc(p)}`;
  });
  const problems = Object.entries(sources).flatMap(([p, info]) => {
    const ageDays = (Date.now() - new Date(info.fetched_at).getTime()) / 86400000;
    const old = ageDays > 1 ? `${plural(Math.floor(ageDays), "day")} old` : "";
    if (info.error) return [`${esc(providerName(p))} didn't answer on the last update${old ? `, its data is ${old}` : ""}.`];
    return old ? [`The ${esc(providerName(p))} data is ${old}.`] : [];
  });
  const when = new Date(data.fetched_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("dataInfo").innerHTML =
    `${counts.join(" · ")} · updated ${esc(when)}` +
    (problems.length ? `<span class="stale">${problems.join(" ")} Run update-data.bat for fresh rallies.</span>` : "");

  fillHomeSelect();
  fillProviders();
  writeForm();
  if (landing) startLanding();
  else compute();
})();
