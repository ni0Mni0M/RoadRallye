(function () {
  "use strict";

  const M = window.RallyMatching;
  const W = window.WayHome;
  const R = window.RallyRanking;
  const data = window.RALLY_DATA;
  const routeData = window.ROUTE_DATA || null; // road, countries and scenery per route (fetch_route_info.py)
  const climateData = window.CLIMATE_DATA || null; // typical weather per station (fetch_climate.py)
  const $ = (id) => document.getElementById(id);
  // Every text comes from web/lang/*.js in the page's language (i18n.js); `t` is taken by the trips.
  const tr = I18n.t;
  const num = (x, opts) => I18n.numbers(opts).format(x);

  const STORAGE_KEY = "rally-finder-settings-v1";
  const PERSONAL_KEY = "rally-finder-personal-v1";
  const PAGE_SIZE = 100;
  // Where each provider's rallies are booked: book(rally, its start station, its end station).
  // Stations saved before Imoova was added have no provider: roadsurfer.
  const PROVIDERS = {
    roadsurfer: {
      name: "roadsurfer",
      note: () => tr("provider.roadsurfer", { price: euros(129) }),
      book: (r) =>
        "https://booking.roadsurfer.com/rally/pick" +
        `?station=${r.from}&end_station=${r.to}&pickup_date=${r.pickup}&return_date=${r.return}&currency=EUR`,
    },
    imoova: {
      name: "Imoova",
      note: () => tr("provider.imoova", { price: euros(1) }),
      book: (r) => `https://www.imoova.com/en/relocations/${encodeURIComponent(r.ref)}`,
    },
    movacar: {
      name: "Movacar",
      note: () => tr("provider.movacar", { price: euros(1) }),
      // Movacar has no page for one offer without logging in: this lists the route's offers, in the visitor's language.
      book: (r, from, to) =>
        `https://www.movacar.com/offers/${encodeURIComponent(from.city || from.name)}/${encodeURIComponent(to.city || to.name)}`,
    },
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The map's colours point at the variables in style.css rather than holding their values,
  // so everything already drawn follows a switch between the light and the dark theme.
  const COLORS = {
    out: "var(--out)",
    back: "var(--back)",
    mid: "var(--mid)",
    hop: "var(--hop)",
    far: "var(--far)",
    panel: "var(--panel)",
    ink: "var(--text)",
  };

  // ---------- Theme ----------

  // The page follows the system until the sun/moon button is used; index.html applies a saved choice.
  const THEME_KEY = "rally-finder-theme";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const darkNow = () => (document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light")) === "dark";

  function labelThemeToggle() {
    const label = tr(darkNow() ? "theme.toLight" : "theme.toDark");
    $("themeToggle").title = label;
    $("themeToggle").setAttribute("aria-label", label);
  }

  $("themeToggle").addEventListener("click", () => {
    const theme = darkNow() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // Blocked storage: the theme lasts until the page is closed.
    }
    labelThemeToggle();
  });
  systemDark.addEventListener("change", labelThemeToggle);
  labelThemeToggle();

  // Dates, numbers and amounts are written the way the page's language writes them ("Mon 5 Jan", "Mo., 5. Jan.").
  const fmtDay = (iso) =>
    I18n.dates({ weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));
  const fmtKm = (km) => `${num(Math.round(km))} km`;
  const cap = (s) => (s ? s[0].toLocaleUpperCase(I18n.locale()) + s.slice(1) : s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtPrice(amount, currency) {
    try {
      return num(amount, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
    } catch (e) {
      return `${Math.round(amount)} ${currency}`; // unknown currency code
    }
  }
  // "€719" in English, "719 €" in German; cents only where they matter (a fuel price).
  const euros = (x) => fmtPrice(Math.round(x), "EUR");
  const eurosCents = (x) => num(x, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Month i (0-11) by name: "narrow" ("J"), "short" ("Jan") or "long" ("January").
  const monthName = (i, month) => I18n.dates({ month, timeZone: "UTC" }).format(new Date(Date.UTC(2001, i, 15)));

  // Prices are shown in euros. Other currencies are converted at the ECB rate saved with the data
  // ("≈ €91"), with the listed price in the tooltip; without a rate the listed price is shown.
  function priceHtml(r) {
    if (typeof r.price !== "number") return "";
    const currency = r.currency || "EUR";
    const rate = currency !== "EUR" && data.rates && data.rates.per_eur[currency];
    if (!rate) return esc(fmtPrice(r.price, currency));
    const listed = tr("price.ecb", { price: fmtPrice(r.price, currency), date: data.rates.date });
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
    return h ? (r ? tr("unit.hMin", { h, m: r }) : tr("unit.h", { h })) : tr("unit.min", { m: r });
  }

  // "4–6½ h", or "40–70 min" for short trips.
  function fmtRange(lowMin, highMin) {
    if (highMin < 90) return tr("unit.rangeMin", { from: Math.round(lowMin / 10) * 10, to: Math.round(highMin / 10) * 10 });
    const half = (h) => (Number.isInteger(h) ? `${h}` : `${Math.floor(h) || ""}½`);
    return tr("unit.rangeH", { from: half(Math.floor(lowMin / 30) / 2), to: half(Math.ceil(highMin / 30) / 2) });
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
  const siteKind = (kind) => tr(kind === "park" ? "site.park" : "site.unesco");
  const OPEN_METEO = '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>';
  const OSRM = '<a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a>';

  if (!data || !Array.isArray(data.rallies)) {
    $("dataInfo").textContent = tr("data.none");
    const help = tr("data.noneHelp", { script: "<code>update-data.bat</code>", command: "<code>python scraper/fetch_rallies.py</code>" });
    $("results").innerHTML = `<li class="empty">${help}</li>`;
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
  // One rental company's station listed by two sources (roadsurfer's Marburg and Movacar's) is one station.
  const stationTwins = M.stationTwins(data);
  const sameStation = (a, b) => a === b || (stationTwins.has(a) && stationTwins.get(a).has(b));

  const today = localToday();
  const berlin = homeChoices.find((s) => s.name === "Berlin");

  const DEFAULTS = {
    home: (berlin || homeChoices[0]).id,
    startRadius: 50,
    returnRadius: 300,
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
    insurance: 15, // the package's price per day; only counted when includeInsurance is on
    includeInsurance: false, // ticked in a trip's cost details
    vanConsumption: 10,
    normalDayPrice: 90, // what a van costs per day without the rally discount (a rough guess)
    oneWayFee: 250, // what dropping it off at another station costs on a normal rental (a rough guess)
    view: "trips",
    rankMode: "destinations",
    rankBy: "dates",
    combine: ["dates", "warmth", "scenic"],
    onlyFavs: false,
    hideVisited: false,
  };
  const NOT_NEGATIVE = ["rallyFee", "normalDayPrice", "oneWayFee"]; // amounts that may be 0
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
    s.includeInsurance = s.includeInsurance === true;
    if (!TIME_OF_DAY.test(s.dropoffTime)) s.dropoffTime = DEFAULTS.dropoffTime;
    for (const key of ["carConsumption", "fuelPrice", "vanConsumption"]) if (!(s[key] > 0)) s[key] = DEFAULTS[key];
    for (const key of NOT_NEGATIVE) if (!(s[key] >= 0)) s[key] = DEFAULTS[key];
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
  const openCosts = new Set(); // trip ids whose cost details are slid out; kept when the list is redrawn
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
  // "5 round trips", "1 one-way trip": a number of trips of the current kind.
  const tripsText = (n) => tr(oneWay() ? "trips.oneway" : "trips.round", { n });
  const maxLegs = () => (oneWay() ? ONE_WAY_LEG_CHOICES.indexOf(settings.legsOneWay) + 1 : settings.legs === "2" ? 2 : 3);
  // A round trip only passes through the places it stops at; a one-way trip also ends at one. The texts
  // that name such a place come in these three versions ("chip.via", "chip.to", "chip.toOrVia").
  const viaKind = () => (!oneWay() ? "via" : maxLegs() === 1 ? "to" : "toOrVia");

  // ---------- Form ----------

  function fillHomeSelect() {
    const byCountry = new Map();
    for (const s of homeChoices) {
      const country = s.country ? countryName(s.country) : tr("filters.otherCountry");
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(s);
    }
    const lang = I18n.locale();
    $("home").innerHTML = [...byCountry.keys()]
      .sort((a, b) => a.localeCompare(b, lang))
      .map((country) => {
        const options = byCountry
          .get(country)
          .sort((a, b) => a.name.localeCompare(b.name, lang))
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
        const note = PROVIDERS[p] ? `<small>${esc(PROVIDERS[p].note())}</small>` : "";
        return `<label class="check"><input type="checkbox" value="${esc(p)}"><span>${esc(providerName(p))}${note}</span></label>`;
      })
      .join("");
  }

  const providerBoxes = () => [...$("providers").querySelectorAll("input")];

  const FIELDS = [
    "home", "startRadius", "returnRadius", "earliest", "latest", "maxWait", "hopRadius", "sort",
    "dropoffTime", "carConsumption", "fuelPrice", "rallyFee", "insurance", "vanConsumption",
    "normalDayPrice", "oneWayFee",
  ];
  const NUMERIC = new Set([
    "startRadius", "returnRadius", "maxWait", "hopRadius", "carConsumption", "fuelPrice",
    "rallyFee", "insurance", "vanConsumption", "normalDayPrice", "oneWayFee",
  ]);
  const RADIOS = ["tripType", "legs", "legsOneWay"]; // the segmented choices inside the filter form
  // Chosen outside the filter form (view switch, ranking controls), so readForm keeps them.
  const OUTSIDE_FORM = ["includeInsurance", "homeMode","view", "rankMode", "rankBy", "combine", "onlyFavs", "hideVisited"];

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
    // An emptied field reads as 0, which is a valid amount here; only nonsense falls back.
    for (const key of NOT_NEGATIVE) if (!(next[key] >= 0)) next[key] = DEFAULTS[key];
    settings = next;
  }

  function updateOutputs() {
    const v = (id) => Number($(id).value);
    $("startRadiusOut").textContent = v("startRadius") === 0 ? tr("filters.homeOnly") : fmtKm(v("startRadius"));
    $("returnRadiusOut").textContent = fmtKm(v("returnRadius"));
    $("maxWaitOut").textContent = v("maxWait") === 0 ? tr("filters.sameDayOnly") : tr("filters.upToDays", { n: v("maxWait") });
    $("hopRadiusOut").textContent = v("hopRadius") === 0 ? tr("filters.off") : tr("filters.upTo", { km: fmtKm(v("hopRadius")) });

    // One-way or round trip: which filters apply, and what they are called. Read from the form,
    // so the panel follows the switch at once (the trips follow a moment later).
    const form = $("filters").elements;
    const oneWayNow = form.tripType.value === "oneway";
    const chains = !oneWayNow || form.legsOneWay.value !== "1"; // a single rally has no legs to wait or hop between
    $("tripTypeHint").textContent = tr(oneWayNow ? "trip.hint.oneway" : "trip.hint.round");
    $("returnField").hidden = oneWayNow;
    $("latestLabel").textContent = tr(oneWayNow ? "filters.latestDropoff" : "filters.backBy");
    $("legsOneWayField").hidden = !oneWayNow;
    $("legsRoundField").hidden = oneWayNow;
    $("maxWaitField").hidden = !chains;
    $("hopField").hidden = !chains;
    // "More options" says how many of its filters are off their defaults, so a folded-away
    // filter never narrows the trips unseen. With nothing in it to show, it goes.
    const changed =
      (chains && v("maxWait") !== DEFAULTS.maxWait ? 1 : 0) +
      (chains && v("hopRadius") !== DEFAULTS.hopRadius ? 1 : 0) +
      (providerBoxes().some((box) => !box.checked) ? 1 : 0);
    $("moreOptions").hidden = !chains && $("providerSet").hidden;
    $("moreChanged").textContent = changed ? tr("more.changed", { n: changed }) : "";
    $("sortDistance").textContent = tr(oneWayNow ? "sort.farthest" : "sort.closest");
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
    if (!settings.earliest || !settings.latest) return tr("date.pickBoth");
    if (settings.latest < settings.earliest) return tr(oneWay() ? "date.error.oneway" : "date.error.round");
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
    $("legendOutText").textContent = tr(oneWay() ? "legend.first" : "legend.outbound");
    $("legendMidText").textContent = tr(oneWay() ? "legend.onward" : "legend.middle");
    $("legendMid").hidden = !chains;
    $("legendBack").hidden = oneWay();
    $("legendHop").hidden = oneWay() && !chains;
    $("legendHome").hidden = !settings.wayHome;
    $("legendReturnArea").hidden = oneWay();
  }

  const costSettings = () => ({
    rallyFee: settings.rallyFee,
    insurancePerDay: settings.includeInsurance ? settings.insurance : 0,
    vanLitresPer100Km: settings.vanConsumption,
    fuelPrice: settings.fuelPrice,
    priceEur,
    normalDayPrice: settings.normalDayPrice,
    oneWayFee: settings.oneWayFee,
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
  // Movacar prices are the rent for the included days; fuel, extra days and extra km come on top.
  function legHtml(kind, r) {
    const a = stations.get(r.from);
    const b = stations.get(r.to);
    const p = providerOf(r);
    const source =
      esc(providerName(p)) +
      (r.supplier ? ` (${esc(tr("leg.supplier", { supplier: r.supplier }))})` : "") +
      (typeof r.price === "number" ? ` · ${priceHtml(r)}` : "");
    const bookLabel = tr("leg.bookLabel", { from: a.name, to: b.name, provider: providerName(p) });
    const book = PROVIDERS[p]
      ? `<a class="book" href="${esc(PROVIDERS[p].book(r, a, b))}" target="_blank" rel="noopener" ` +
        `aria-label="${esc(bookLabel)}">${esc(tr("leg.book"))} ↗</a>`
      : "";
    return (
      `<div class="leg ${kind}">` +
      '<span class="leg-dot" aria-hidden="true"></span>' +
      '<div class="leg-text">' +
      `<span class="leg-dates">${fmtDay(r.pickup)} → ${fmtDay(r.return)}</span>` +
      '<span class="leg-stations">' +
      `<span class="leg-route">${esc(a.name)} → ${esc(b.name)} · ${tr("count.days", { n: M.daysBetween(r.pickup, r.return) })}</span>` +
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
    if (!sameStation(arrive.id, depart.id)) {
      const acrossTown = t.hops[i] <= M.SAME_PLACE_KM && providerById.get(arrive.id) !== providerById.get(depart.id);
      const key = `between.${acrossTown ? "town" : "train"}${wait ? "Later" : "SameDay"}`;
      const text = tr(key, { from: esc(arrive.name), to: esc(depart.name), km: fmtKm(t.hops[i]), n: wait });
      return `<p class="between">${text}</p>`;
    }
    return wait ? `<p class="between">${tr("between.wait", { n: wait, place: esc(arrive.name) })}</p>` : "";
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
    const summary = [tr("count.days", { n: t.totalDays })];
    if (n > (t.type === "oneway" ? 1 : 2)) summary.push(tr("count.rallies", { n }));
    if (n > 1) summary.push(t.waitDays === 0 ? tr("trip.noWaiting") : tr("trip.waiting", { n: t.waitDays }));
    summary.push(tr("trip.endsFrom", { km: fmtKm(t.endKm) }));
    const f = facts.get(t.id);
    const paceLine = f
      ? `<p class="facts">${tr("trip.kmPerDay", { n: Math.round(f.kmPerDay) })}${f.countries.length > 1 ? ` · ${f.countries.join(" → ")}` : ""}</p>`
      : "";

    return (
      `<li class="trip${t.id === selectedId ? " selected" : ""}" data-id="${esc(t.id)}" tabindex="0">` +
      `<h3>${title}</h3>` +
      body +
      `<p class="facts">${summary.join(" · ")}</p>` +
      paceLine +
      (f ? costHtml(t, f) : "") +
      timelineHtml(t) +
      "</li>"
    );
  }

  // The price of a trip: "≈ €719 · rent €219 + fuel €500", then a button ("You save ≈ €691") that
  // slides out how both the rally price and the normal rental it is compared with add up.
  // The normal rental is a guess from two settings, so everything derived from it is marked "≈".
  function costHtml(t, f) {
    const p = f.costParts;
    const open = openCosts.has(t.id);
    const row = (label, amount, cls = "") => `<div class="cost-row${cls}"><span>${label}</span><span>${amount}</span></div>`;
    const times = (n, amount) => `${n} × ${euros(amount)}`;
    const dist = f.measured ? fmtKm(f.roadKm) : tr("cost.estimated", { km: fmtKm(f.roadKm) });

    // Insurance is extra: a ticked box adds it to every trip's total (and to the normal rental, which
    // would need the same cover). Rallies with a listed price have none to add.
    const insured = settings.includeInsurance;
    const insurance = p.feeLegs && settings.insurance > 0 ? p.feeDays * settings.insurance : 0;

    const rally = [];
    if (p.feeLegs) {
      const fee = p.feeLegs > 1 ? tr("cost.rallyFeeTimes", { times: times(p.feeLegs, settings.rallyFee) }) : tr("cost.rallyFee");
      rally.push(row(fee, euros(p.feeLegs * settings.rallyFee)));
    }
    if (p.listedLegs) {
      rally.push(row(p.listedLegs > 1 ? tr("cost.listedPrices", { n: p.listedLegs }) : tr("cost.listedPrice"), euros(p.listedRent)));
    }
    rally.push(row(tr("cost.fuel", { distance: dist }), euros(f.fuel)));
    if (insurance) {
      const label = tr("cost.insurance", { days: tr("count.days", { n: p.feeDays }), price: euros(settings.insurance) });
      rally.push(
        `<label class="cost-row cost-opt${insured ? " on" : ""}" title="${esc(tr("cost.insuranceTitle"))}">` +
        `<span><input type="checkbox" data-insurance${insured ? " checked" : ""}>${label}</span>` +
        `<span>${insured ? "" : "+ "}${euros(insurance)}</span></label>`
      );
    }
    rally.push(row(tr("cost.total"), `≈ ${euros(f.cost)}`, " cost-sum"));

    // One-way fees: none for a trip that ends where it starts, else one per stretch without a break.
    const n = f.oneWayFees;
    const normalCost = f.normalRent + f.fuel;
    const rent = tr("cost.rent", { days: tr("count.days", { n: f.rallyDays }), price: euros(settings.normalDayPrice) });
    const oneWayFee = n > 1 ? tr("cost.oneWayFeeTimes", { times: times(n, settings.oneWayFee) }) : tr("cost.oneWayFee");
    const normal = [row(rent, euros(f.rallyDays * settings.normalDayPrice))];
    if (n) normal.push(row(oneWayFee, euros(n * settings.oneWayFee)));
    normal.push(row(tr("cost.fuelSame"), euros(f.fuel)));
    if (insurance && insured) normal.push(row(tr("cost.insuranceSame"), euros(insurance)));
    normal.push(row(tr("cost.total"), `≈ ${euros(normalCost)}`, " cost-sum"));
    const saves = f.saving > 0;
    const share = num(f.saving / normalCost, { style: "percent", maximumFractionDigits: 0 });
    const outcome = saves
      ? row(tr("cost.youSave"), `≈ ${euros(f.saving)} (${share})`, " cost-save")
      : row(tr("cost.costsMore"), `≈ ${euros(-f.saving)}`);
    const id = `costs-${esc(t.id)}`;
    const note = tr(n > 1 ? "cost.noteEach" : n ? "cost.note" : "cost.noteNone", { day: euros(settings.normalDayPrice), fee: euros(settings.oneWayFee) });

    return (
      `<p class="facts" title="${esc(tr(insured ? "cost.summaryTitleInsured" : "cost.summaryTitle", { distance: dist }))}">` +
      `<strong class="cost-total">≈ ${euros(f.cost)}</strong> · ${tr("cost.split", { rent: euros(f.rent), fuel: euros(f.fuel) })}</p>` +
      `<button type="button" class="cost-toggle${saves ? " saves" : ""}" data-costs aria-expanded="${open}" aria-controls="${id}">` +
      `<span>${saves ? tr("cost.saveButton", { amount: euros(f.saving) }) : tr("cost.details")}</span>` +
      '<span class="cost-chevron" aria-hidden="true"></span></button>' +
      `<div class="cost-slide${open ? " open" : ""}" id="${id}"><div><div class="cost-details">` +
      `<div class="cost-head">${tr("cost.withRally")}</div>` +
      rally.join("") +
      `<div class="cost-head">${tr("cost.normalHead")}</div>` +
      normal.join("") +
      outcome +
      `<p class="cost-note">${note}</p>` +
      "</div></div></div>"
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
    const longerKey =
      oneWay() && maxLegs() > 1 ? (maxLegs() === 2 ? "trips.withTwo" : "trips.withTwoOrThree")
        : !oneWay() && settings.legs === "2-3" ? "trips.withThree"
          : null;
    const longerText = longerKey ? ` · ${tr(longerKey, { n: longer })}` : "";
    $("resultCount").textContent = n ? tripsText(n) + longerText : tr(oneWay() ? "trips.none.oneway" : "trips.none.round");
    const chip = (label) =>
      `<span class="chip">${label}<button type="button" id="clearVia" aria-label="${esc(tr("trips.showAll"))}">×</button></span>`;
    $("viaChip").innerHTML =
      via !== null ? chip(tr(`chip.${viaKind()}`, { place: esc(stations.get(via).name) }))
        : startVia !== null ? chip(tr("chip.startingAt", { place: esc(stations.get(startVia).name) }))
          : "";

    if (!n) {
      const empty = tr(oneWay() ? "empty.oneway" : settings.legs === "3" ? "empty.round3" : "empty.round");
      $("results").innerHTML = $("dateError").textContent ? "" : `<li class="empty">${empty}</li>`;
      return;
    }
    const rest = n - shown;
    const more = tr("trips.showMore", { n: Math.min(PAGE_SIZE, rest) });
    $("results").innerHTML =
      trips.slice(0, shown).map(tripHtml).join("") +
      (rest > 0 ? `<li class="more"><button type="button" id="showMore">${more}</button></li>` : "");
  }

  // ---------- Ranking ----------

  // "Spain", "Spanien", "Espagne": country names come from the browser, in the page's language.
  function countryName(code) {
    try {
      return I18n.regions().of(code);
    } catch (e) {
      return code;
    }
  }
  const freshSince = R.freshSince(data.fetched_at, data.tracking_since);
  const rankKey = () => (settings.rankBy === "favourites" ? "trips" : settings.rankBy);

  // Why a ranking can't be used right now, or "" when it can.
  function rankUnavailable(key) {
    const m = R.METRICS[key];
    if (!m) return "";
    if (m.types && !m.types.includes(settings.tripType)) return tr("rank.why.roundOnly");
    if (!m.modes.includes(settings.rankMode)) return tr("rank.why.destinationsOnly");
    if (m.needs === "routes" && !routeData) return tr("rank.why.routes");
    if (m.needs === "climate" && !climateData) return tr("rank.why.weather");
    if (m.needs === "tracking" && !freshSince) return tr("rank.why.tracking");
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
    const group = (label, keys) => `<optgroup label="${esc(label)}">${keys.map((k) => option(k, metricLabel(k))).join("")}</optgroup>`;
    $("rankBy").innerHTML =
      [...groups].map(([g, keys]) => group(tr(`rankGroup.${g}`), keys)).join("") +
      group(tr("rankGroup.Personal"), ["favourites"]) +
      group(tr("rankGroup.Several"), ["combined"]);
    $("rankBy").value = settings.rankBy;

    $("combineChips").hidden = settings.rankBy !== "combined";
    $("combineChips").innerHTML = Object.keys(R.METRICS)
      .filter((k) => !rankUnavailable(k))
      .map((k) => `<label class="chip-check"><input type="checkbox" value="${k}"${settings.combine.includes(k) ? " checked" : ""}><span>${esc(metricLabel(k))}</span></label>`)
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

  // The ranking's names live in ranking.js in English; the page shows them in its language.
  const metricLabel = (key) => tr(`metric.${key}`);

  function fmtMetric(key, v) {
    if (v === null || v === undefined) return "–";
    switch (key) {
      case "dates": return tr("count.dates", { n: v });
      case "backups": return tr("value.backups", { n: v });
      case "trips": return tr("count.trips", { n: v });
      case "stay": return v ? tr("count.days", { n: v }) : tr("value.sameDay");
      case "pace": return tr("value.pace", { n: Math.round(v) });
      case "distance": return fmtKm(v);
      case "countries": return tr("count.countries", { n: v });
      case "warmth": return `${num(Math.round(v))} °C`;
      case "sun": return tr("value.sun", { n: num(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
      case "dry": return tr("count.rainyDays", { n: Math.round(v) });
      case "scenic": return tr("count.points", { n: Math.round(v) });
      case "cost": return euros(v);
      case "costPerDay": return tr("value.perDay", { price: euros(v) });
      case "fresh": return tr("value.fresh", { n: v });
      case "soonest": return v === 0 ? tr("value.today") : v === 1 ? tr("value.tomorrow") : tr("value.inDays", { n: v });
      case "combined": return `${Math.round(v * 100)}/100`;
      default: return String(v);
    }
  }

  function weatherText(row) {
    const months = climateData && climateData.stations[String(row.id)];
    if (!months || row.arrivalMonth === null) return "";
    const w = months[row.arrivalMonth];
    return tr("weather.arriving", {
      month: monthName(row.arrivalMonth, "long"),
      temp: Math.round(w.t),
      sun: w.sun,
      rain: tr("count.rainyDays", { n: Math.round(w.rain) }),
      period: esc(climateData.period),
    });
  }

  // "A, B, C, D, +14 more" as plain text.
  const someNames = (names, max = 4) =>
    names.slice(0, max).join(", ") + (names.length > max ? `, ${tr("list.more", { n: names.length - max })}` : "");

  function scenicText(t) {
    const f = facts.get(t.id);
    const parts = [
      f.parks.length && tr("count.parks", { n: f.parks.length }),
      f.unesco.length && tr("count.unesco", { n: f.unesco.length }),
      f.coastKm && tr("scenic.coast", { km: fmtKm(f.coastKm) }),
      f.mountainKm && tr("scenic.mountains", { km: fmtKm(f.mountainKm) }),
    ].filter(Boolean);
    const names = [...f.parks, ...f.unesco];
    const route = esc(routeText(t));
    return (
      (parts.length ? tr("scenic.on", { parts: parts.join(" · "), route }) : tr("scenic.none", { route })) +
      (names.length ? `<span class="rank-names">${esc(someNames(names))}</span>` : "")
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
        return tr("detail.cost", { price: euros(f(t).cost), route: esc(routeText(t)), days: tr("count.days", { n: t.totalDays }) });
      }
      case "pace":
        return tr("detail.pace", { n: Math.round(f(row.best.pace).kmPerDay), route: esc(routeText(row.best.pace)) });
      case "stay":
        return row.values.stay ? tr("detail.stay", { days: tr("count.days", { n: row.values.stay }) }) : tr("detail.staySameDay");
      case "fresh":
        return tr("detail.fresh", { fresh: row.values.fresh, trips: tr("count.trips", { n: row.trips }), date: fmtDay(freshSince) });
      case "soonest":
        return tr("detail.soonest", { date: fmtDay(row.dateList[0]) });
      case "distance":
        return tr("detail.distance", { km: fmtKm(row.values.distance), home: esc(stations.get(settings.home).name) });
      case "combined":
        return (
          '<span class="rank-parts">' +
          Object.entries(row.parts)
            .map(([k, p]) => `<span class="part"><span>${esc(metricLabel(k))}</span><span class="part-bar"><i style="width:${Math.round(p * 100)}%"></i></span></span>`)
            .join("") +
          "</span>"
        );
      default:
        return tr("detail.dates", { dates: someNames(row.dateList.map(fmtDay), 3) });
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
    const away = settings.rankMode === "destinations"
      ? ` · ${tr("rank.away", { km: fmtKm(M.haversineKm(stations.get(settings.home), stations.get(row.id))) })}`
      : "";
    const favLabel = esc(tr("rank.favouriteOf", { name: row.name }));
    const beenLabel = esc(tr("rank.beenOf", { name: row.name }));
    return (
      `<li class="rank-row" data-station="${esc(row.id)}" tabindex="0">` +
      `<span class="rank-no">${row.rank === null ? "–" : position}</span>` +
      '<div class="rank-main">' +
      `<h3>${esc(row.name)} <span class="rank-country">${esc(countryName(row.country))}</span></h3>` +
      `<p class="rank-sub">${tr("count.departureDates", { n: row.values.dates })} · ${tripsText(row.trips)}${away}</p>` +
      `<p class="rank-detail">${detailHtml(row, key)}</p>` +
      dateStripHtml(row) +
      "</div>" +
      '<div class="rank-side">' +
      `<span class="rank-value">${fmtMetric(key, row.values[key])}</span>` +
      '<span class="rank-actions">' +
      `<button type="button" class="icon-btn" data-fav aria-pressed="${fav}" title="${esc(tr("rank.favourite"))}" aria-label="${favLabel}">${fav ? "★" : "☆"}</button>` +
      `<button type="button" class="icon-btn" data-visited aria-pressed="${been}" title="${esc(tr("rank.been"))}" aria-label="${beenLabel}">✓</button>` +
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
    const what = tr(`rank.what.${settings.rankMode}.${settings.tripType}`);
    $("rankCount").textContent = rows.length ? tr("rank.count", { stations: tr("count.stations", { n: rows.length }), what }) : "";

    const notes = [];
    if (!routeData) notes.push(tr("rank.note.routes"));
    if (!climateData) notes.push(tr("rank.note.weather"));
    if (!freshSince && data.tracking_since) notes.push(tr("rank.note.tracking", { date: fmtDay(data.tracking_since) }));
    if (rows.length && rows.every((r) => r.rank === null)) notes.push(tr("rank.note.incomplete"));
    $("rankNote").textContent = notes.join(" ");

    const empty = allTrips.length ? tr("rank.empty.marks") : tr(oneWay() ? "rank.empty.oneway" : "rank.empty.round");
    $("ranking").innerHTML = rows.length
      ? rows.map((r, i) => rankRowHtml(r, i + 1)).join("")
      : `<li class="empty">${empty}</li>`;

    const key = rankKey();
    const credits = [];
    if (["warmth", "sun", "dry"].includes(key) || (key === "combined" && settings.combine.some((k) => ["warmth", "sun", "dry"].includes(k)))) {
      credits.push(tr("credit.weather", { link: OPEN_METEO }));
    }
    if (routeData) credits.push(tr("credit.routes", { link: OSRM }));
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
          .bindTooltip(`<strong>${i + 1}. ${esc(s.name)}</strong><br>${fmtMetric(key, row.values[key])} · ${tr("rank.clickForTrips")}`, {
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
      .bindTooltip(tr("map.home", { name: esc(home.name) }), { direction: "top", offset: [0, -14] })
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
      const km = sameStation(settings.home, s.id) ? 0 : M.haversineKm(home, s);
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
      const where = role === "out" ? tr("legend.startArea") : role === "back" ? tr("legend.returnArea") : tr("map.fromHome", { km: fmtKm(km) });
      const filtered = via === s.id ? ` ${tr("map.filtered")}` : "";
      const tripsLine = n ? `<br>${tr(`map.trips.${viaKind()}`, { n, place: esc(s.name) })}${filtered}` : "";
      const source = providersInData.length > 1 ? ` · ${esc(providerName(providerById.get(s.id)))}` : "";
      marker.bindTooltip(
        `<strong>${esc(s.name)}</strong>${source}<br>${where}${tripsLine}<br><span class="tip-hint">${tr("map.clickForOptions")}</span>`,
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
    if (w.t !== null) parts.push(tr("weather.highs", { n: Math.round(w.t) }));
    if (w.sun !== null) parts.push(tr("weather.sun", { n: w.sun }));
    if (w.rain !== null) parts.push(tr("count.rainyDays", { n: Math.round(w.rain) }));
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
        return `<i class="${marked.has(i) ? "on" : ""}" style="height:${h}px" title="${esc(cap(monthName(i, "short")))}: ${esc(monthWeather(w))}"></i>`;
      })
      .join("");
    const first = [...marked][0];
    const letters = months.map((w, i) => `<span>${esc(cap(monthName(i, "narrow")))}</span>`).join("");
    return (
      '<div class="wx">' +
      `<div class="wx-bars" aria-hidden="true">${bars}</div>` +
      `<div class="wx-months" aria-hidden="true">${letters}</div>` +
      (first !== undefined ? `<p class="wx-note">${esc(cap(monthName(first, "long")))}: ${esc(monthWeather(months[first]))}</p>` : "") +
      `<p class="wx-credit">${tr("weather.stripCredit", { period: esc(climateData.period) })} · ${OPEN_METEO}</p>` +
      "</div>"
    );
  }

  // The menu a click on a station opens: make it the home station, or list only the trips that stop there.
  function stationMenu(s, viaCount) {
    const target = homeFor(s);
    const count = homeCounts.get(target.id);
    const asHome = count === undefined ? tr("menu.counting") : tripsText(count);
    const source = providersInData.length > 1 ? ` · ${esc(providerName(providerById.get(s.id)))}` : "";
    const lines = [`<p><strong>${esc(s.name)}</strong>${source}</p>`];
    lines.push(weatherStripHtml(s));
    if (target.id === settings.home) {
      lines.push(`<p>${tr("menu.yourHome")}</p>`);
    } else {
      const same = target.id === s.id;
      const name = esc(target.name);
      lines.push(`<p>${same ? tr("menu.asHome", { trips: asHome }) : tr("menu.asHomeOther", { name, trips: asHome })}</p>`);
      lines.push(`<button type="button" data-action="home">${same ? tr("menu.setHome") : tr("menu.setHomeOther", { name })}</button>`);
    }
    if (via === s.id) lines.push(`<button type="button" data-action="via">${tr("menu.showAllAgain")}</button>`);
    else if (viaCount) {
      lines.push(`<button type="button" data-action="via">${tr(`menu.trips.${viaKind()}`, { place: esc(s.name), n: viaCount })}</button>`);
    }

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
        .bindTooltip(`<strong>${esc(s.name)}</strong><br>${siteKind(s.kind)}`, { direction: "top", offset: [0, -6] })
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
        // The search covers two days; keep only the three worth showing, the fastest first.
        const found = body.itineraries || [];
        const summaries = found.map(W.summarizeItinerary);
        const options = W.pickConnections(summaries).map((i) => ({ ...summaries[i], legs: found[i].legs }));
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
      return I18n.dates({ ...opts, timeZone: timeZone || undefined }).format(new Date(iso));
    } catch (e) {
      return I18n.dates(opts).format(new Date(iso)); // unknown time zone name
    }
  }

  const SEARCH_DAYS = 2; // serve.py asks Transitous for the 48 hours after the drop-off

  const whIcon = (shapes) =>
    '<svg class="wh-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
    `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
  const VEHICLES = {
    train: {
      word: () => tr("vehicle.train"),
      icon: whIcon('<rect x="3.5" y="1.5" width="9" height="10" rx="2"/><path d="M3.5 7h9M6 9.3h.01M10 9.3h.01M5.5 11.5 4 14.5M10.5 11.5l1.5 3"/>'),
    },
    bus: {
      word: () => tr("vehicle.bus"),
      icon: whIcon('<rect x="2" y="2.5" width="12" height="9" rx="1.5"/><path d="M2 7.5h12M4.5 11.5v2M11.5 11.5v2M5 9.5h.01M11 9.5h.01"/>'),
    },
    ferry: {
      word: () => tr("vehicle.ferry"),
      icon: whIcon('<path d="M2 9.5h12l-1.5 3.5h-9zM4.5 9.5v-4h7v4M8 5.5v-3"/>'),
    },
  };
  const MOON_ICON = whIcon('<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/>');

  // "Train", "Bus" or "Train and bus" ("Zug und Bus"), with their icons in front.
  function vehiclesHtml(kinds) {
    if (!kinds.length) return tr("vehicle.onFoot");
    const words = I18n.lists().format(kinds.map((k) => VEHICLES[k].word()));
    return kinds.map((k) => VEHICLES[k].icon).join("") + esc(cap(words));
  }

  const daysBetween = (fromDay, toDay) => Math.round((new Date(`${toDay}T00:00:00Z`) - new Date(`${fromDay}T00:00:00Z`)) / 864e5);

  const extLink = (url, text) => `<a class="book" href="${url}" target="_blank" rel="noopener">${text} ↗</a>`;

  // Why live times are missing, by the reason serve.py gives.
  const TRANSIT_TROUBLE = {
    "no-server": "transit.noServer",
    "no-contact": "transit.noContact",
    limit: "transit.limit",
    upstream: "transit.upstream",
  };

  let whDetailsOpen = false; // whether "Connection details" is slid out; kept while you switch connections and trips

  // The way home shows as two buttons (train & bus, car); a click on one opens its details. They
  // fold away again with a second click on that button, after 30 seconds without any input, once
  // they are scrolled out of sight, and when another trip is picked (selectTrip).
  const WH_IDLE_MS = 30000;
  const WH_INPUTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
  let whOpen = false;
  let whIdleTimer = 0;
  const whSeen = new IntersectionObserver((entries) => {
    if (whOpen && !entries[entries.length - 1].isIntersecting) closeWayHome();
  });

  function restartWhIdle() {
    clearTimeout(whIdleTimer);
    whIdleTimer = setTimeout(closeWayHome, WH_IDLE_MS);
  }

  function openWayHome() {
    if (!whOpen) {
      for (const type of WH_INPUTS) document.addEventListener(type, restartWhIdle, { capture: true, passive: true });
    }
    whOpen = true;
    restartWhIdle();
  }

  // `redraw: false` when the caller is about to draw the card anyway.
  function closeWayHome(redraw = true) {
    if (!whOpen) return;
    whOpen = false;
    clearTimeout(whIdleTimer);
    whSeen.disconnect();
    for (const type of WH_INPUTS) document.removeEventListener(type, restartWhIdle, { capture: true });
    const t = trips.find((x) => x.id === selectedId);
    if (redraw !== false && t) renderWayHome(t);
  }

  // Exact minutes, unlike fmtDuration: a 7-minute change must not read as 5.
  function fmtMinutes(min) {
    const m = Math.round(min);
    return m >= 60 ? tr("unit.hMin", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") }) : tr("unit.min", { m });
  }

  // The chosen connection step by step: every station with its time, every ride and every change.
  function stepsHtml(option, home) {
    const steps = W.connectionSteps(option.legs);
    const firstStop = steps.find((s) => s.type === "stop");
    if (!firstStop) return "";
    const firstDay = W.localDay(firstStop.time, firstStop.tz);
    const items = steps.map((s) => {
      if (s.type === "stop") {
        const day = W.localDay(s.time, s.tz);
        const extra = (s.track ? ` · ${tr("steps.platform", { track: esc(s.track) })}` : "") + (day !== firstDay ? ` · ${fmtDay(day)}` : "");
        return `<li class="wh-stop"><span class="wh-clock">${fmtClock(s.time, s.tz)}</span><span>${esc(s.name)}<span class="wh-extra">${extra}</span></span></li>`;
      }
      if (s.type === "ride") {
        const towards = s.towards ? ` ${tr("steps.towards", { place: esc(s.towards) })}` : "";
        return `<li class="wh-leg ride"><span>${VEHICLES[s.kind].icon}${esc(s.line)}${towards} · ${fmtMinutes(s.durationMin)}</span></li>`;
      }
      if (s.type === "change") {
        const time = fmtMinutes(s.durationMin);
        const text = s.to ? tr("steps.changeWalkTo", { time, place: esc(s.to) })
          : s.walkMin >= 2 ? tr("steps.changeOnFoot", { time, walk: fmtMinutes(s.walkMin) })
            : tr("steps.change", { time });
        return `<li class="wh-leg"><span>${text}</span></li>`;
      }
      const where = s.where === "start" ? tr("steps.walkStart") : tr("steps.walkEnd", { place: esc(home.name) });
      return `<li class="wh-leg"><span>${where} · ${fmtMinutes(s.durationMin)}</span></li>`;
    });
    return (
      `<div class="cost-details"><ol class="wh-steps">${items.join("")}</ol>` +
      `<p class="cost-note">${tr("steps.note")}</p></div>`
    );
  }

  const PLANE_ICON = whIcon(
    '<path transform="scale(0.667)" stroke-width="2.1" d="M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2-7h-4l-2 2h-3l2-4l-2-4h3l2 2h4l-2-7h3z"/>'
  );

  // A tile that opens a flight search, shown when train and bus are a very long way home.
  // `fastest` is the fastest connection, or null when there is none to judge by.
  function flightHtml(end, home, fastest, date) {
    const to = { ...home, country: stations.get(settings.home).country };
    const flight = W.flightSearch(end, to, fastest, date, window.Airports);
    if (!flight) return "";
    const time = fastest && fmtDuration(fastest.durationMin);
    const why = !fastest ? tr("flight.noConnection")
      : fastest.transfers == null ? tr("flight.slow", { time })
        : tr("flight.slowChanges", { time, n: fastest.transfers });
    const route = tr("flight.route", { from: esc(flight.from.city), to: esc(flight.to.city), date: fmtDay(date) });
    return (
      `<a class="wh-flight" href="${flight.url}" target="_blank" rel="noopener">` +
      `<span class="wh-flight-title">${PLANE_ICON}${tr("flight.title")}<span aria-hidden="true">↗</span></span>` +
      `<span>${route}</span>` +
      `<span class="wh-flight-why">${why}</span></a>`
    );
  }

  function transitHtml(end, home, est, live, chosen, date) {
    const mapsLink = extLink(W.googleMapsUrl(end, home, "transit"), "Google Maps");
    const estimate = tr("transit.estimate", { range: fmtRange(est.lowMin, est.highMin) });
    if (!live) return `<p class="wh-main">${tr("transit.looking")}</p>`;
    if (live.error || !live.options.length) {
      // Without live times the estimate from the distance decides; with none found, a flight is the way.
      const flight = flightHtml(end, home, live.error ? { durationMin: est.lowMin, transfers: null } : null, date);
      const why = live.error ? tr(TRANSIT_TROUBLE[live.reason] || TRANSIT_TROUBLE.upstream) : tr("transit.none");
      const retry = live.error && live.reason === "upstream"
        ? `<button type="button" class="wh-retry" data-mode="transit" data-retry="1">${tr("wh.retry")}</button>`
        : "";
      return (
        `<p class="wh-main">${estimate}</p>` +
        `<p class="wh-detail">${why} ${tr("transit.rough")}</p>` +
        flight +
        `<div class="wh-links">${retry}${mapsLink}</div>`
      );
    }

    // The chosen tile also holds the button that slides out its details.
    const details =
      `<div class="wh-more"><button type="button" class="cost-toggle" data-wh-details aria-expanded="${whDetailsOpen}" aria-controls="whSteps">` +
      `<span>${tr("transit.details")}</span><span class="cost-chevron" aria-hidden="true"></span></button>` +
      `<div class="cost-slide${whDetailsOpen ? " open" : ""}" id="whSteps"><div>${stepsHtml(live.options[chosen], home)}</div></div></div>`;
    // The fastest connection comes first (W.pickConnections).
    const rows = live.options.map((o, i) => {
      const startDay = W.localDay(o.start, o.startTz);
      const later = daysBetween(date, startDay);
      const when = later <= 0 ? tr("transit.sameDay") : later === 1 ? tr("transit.nextDay") : tr("transit.daysLater", { n: later });
      const nights = daysBetween(startDay, W.localDay(o.end, o.endTz));
      const changes = o.transfers === 0 ? tr("transit.direct") : tr("count.changes", { n: o.transfers });
      return (
        `<li${i === chosen ? ' class="chosen"' : ""}><button type="button" class="wh-option" data-itinerary="${i}" aria-pressed="${i === chosen}">` +
        `<span class="wh-day">${fmtDay(startDay)} · ${when}</span>` +
        `${i === 0 ? `<span class="wh-tag">${tr("transit.fastest")}</span>` : "<span></span>"}` +
        `<span class="wh-times">${fmtClock(o.start, o.startTz)} → ${fmtClock(o.end, o.endTz)}` +
        `${nights > 0 ? `<span class="wh-plus">+${nights}</span>` : ""}</span>` +
        `<span class="wh-dur">${fmtDuration(o.durationMin)}</span>` +
        `<span class="wh-how">${vehiclesHtml(o.vehicles)} · ${changes}` +
        `${o.overnight ? ` · <span class="wh-night">${MOON_ICON}${tr("transit.overnight")}</span>` : ""}</span>` +
        "</button>" +
        (i === chosen ? details : "") +
        "</li>"
      );
    });
    const until = new Date(`${date}T${settings.dropoffTime}:00`);
    until.setDate(until.getDate() + SEARCH_DAYS);
    const untilDay = I18n.dates({ weekday: "short" }).format(until);
    const time = esc(settings.dropoffTime);
    const transitous = '<a href="https://transitous.org/" target="_blank" rel="noopener">Transitous</a>';
    const sources = `<a href="https://transitous.org/sources/" target="_blank" rel="noopener">${tr("transit.sources")}</a>`;
    return (
      `<p class="wh-main">${tr("transit.bestUntil", { day: untilDay, time })}</p>` +
      flightHtml(end, home, live.options[0], date) +
      `<ol class="wh-options">${rows.join("")}</ol>` +
      `<p class="wh-detail">${tr("transit.searched", { n: SEARCH_DAYS * 24, time })}</p>` +
      `<div class="wh-links">${mapsLink}</div>` +
      `<p class="wh-credit">${tr("transit.credit", { link: transitous, sources })}</p>`
    );
  }

  function carHtml(end, home, drive) {
    const mapsLink = extLink(W.googleMapsUrl(end, home, "driving"), tr("car.mapsLink"));
    if (!drive) return `<p class="wh-main">${tr("car.working")}</p>`;
    if (drive.error) {
      return (
        `<p class="wh-main">${tr("car.failed")}</p>` +
        `<p class="wh-detail">${tr("car.noAnswer")}</p>` +
        `<div class="wh-links"><button type="button" class="wh-retry" data-mode="car" data-retry="1">${tr("wh.retry")}</button>${mapsLink}</div>`
      );
    }
    const cost = W.fuelCost(drive.km, settings.carConsumption, settings.fuelPrice);
    const detail = tr("car.detail", { cost: euros(cost), consumption: settings.carConsumption, price: eurosCents(settings.fuelPrice) });
    return (
      `<p class="wh-main">${fmtKm(drive.km)} · ${fmtDuration(drive.min)}</p>` +
      `<p class="wh-detail">${detail}</p>` +
      `<div class="wh-links">${mapsLink}</div>` +
      `<p class="wh-credit">${tr("car.credit")}</p>`
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
      panel.innerHTML = `<p class="wh-detail">${tr("wh.homeAlready")}</p>`;
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
    if (liveOk && !itineraryChoice.has(tKey)) itineraryChoice.set(tKey, 0); // the fastest is first
    const chosen = liveOk ? itineraryChoice.get(tKey) : -1;

    const transit = W.transitEstimate(end, home);
    const mode = settings.homeMode;

    const tab = (m, label, summary) =>
      `<button type="button" role="tab" class="wh-tab" data-mode="${m}" aria-selected="${whOpen && m === mode}">${label}<span>${summary}</span></button>`;
    const body = !whOpen ? "" : mode === "car" ? carHtml(end, home, drive) : transitHtml(end, home, transit, live, chosen, date);
    const transitSummary = !live
      ? "…"
      : liveOk ? fmtDuration(live.options[0].durationMin) : fmtRange(transit.lowMin, transit.highMin);

    panel.innerHTML =
      `<p class="wh-head">${tr("wh.title", { place: esc(end.name) })}</p>` +
      `<div class="wh-tabs" role="tablist" aria-label="${esc(tr("wh.tabs"))}">` +
      tab("transit", esc(tr("wh.transit")), transitSummary) +
      tab("car", esc(tr("wh.car")), !drive ? "…" : drive.error ? "–" : fmtDuration(drive.min)) +
      "</div>" +
      (whOpen
        ? `<p class="wh-sub">${tr("wh.sub", { date: fmtDay(date), km: fmtKm(crowKm), home: esc(home.name) })}</p>` +
          `<div class="wh-body" role="tabpanel">${body}</div>`
        : "");
    // Watched while open, so scrolling the panel out of sight folds the details away.
    whSeen.disconnect();
    if (whOpen) whSeen.observe(panel);
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
    if (el && settings.wayHome) el.insertAdjacentHTML("beforeend", `<section class="wayhome" aria-label="${esc(tr("wh.section"))}"></section>`);
    renderWayHome(t);
  }

  // ---------- Along the way ----------

  // Parks and World Heritage sites were only looked up in Europe.
  const NO_SITE_LOOKUP = new Set(["US", "CA", "MX"]);

  // One small line icon per kind of fact, so a rally fits in a row; the words are in the tooltip.
  const ALONG_ICONS = {
    road: whIcon('<path d="M5 14 6.5 2M11 14 9.5 2M8 3.5V5M8 7.2v1.6M8 11v1.5"/>'),
    clock: whIcon('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
    park: whIcon('<path d="M8 1.5 3.5 7.5h2.2L3 12h10L10.3 7.5h2.2zM8 12v2.5"/>'),
    unesco: whIcon('<path d="M2 5.5 8 2l6 3.5zM3.5 7.5V12M6.5 7.5V12M9.5 7.5V12M12.5 7.5V12M2 13.8h12"/>'),
    coast: whIcon('<path d="M1.5 6.2c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 2.3-1.2 3.4-.6M1.5 10.7c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 2.3-1.2 3.4-.6"/>'),
    mountain: whIcon('<path d="M1.5 13 6 4.5l2.5 4.5L10 6.5l4.5 6.5z"/>'),
    pin: whIcon('<path d="M8 14.5S3.5 10 3.5 6.5a4.5 4.5 0 0 1 9 0C12.5 10 8 14.5 8 14.5z"/><circle cx="8" cy="6.5" r="1.5"/>'),
    temp: whIcon('<path d="M8 2a1.5 1.5 0 0 1 1.5 1.5v5.3a3 3 0 1 1-3 0V3.5A1.5 1.5 0 0 1 8 2z"/>'),
    sun: whIcon('<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>'),
    rain: whIcon('<path d="M4.5 9.5a2.8 2.8 0 0 1 .4-5.6 3.6 3.6 0 0 1 6.9 1 2.3 2.3 0 0 1-.3 4.6zM5.5 12v1.5M8 12v2M10.5 12v1.5"/>'),
    info: whIcon('<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5.2h.01"/>'),
  };

  // One fact in a row: its icon and a short value (HTML). `title` is the fact in words, shown as
  // the tooltip and read out by screen readers. With `panel`, a click shows the paragraph of that
  // name below the row (the names a number counts, the sources).
  function alongItem(icon, value, title, panel) {
    const label = esc(title);
    return panel
      ? `<button type="button" class="al-item al-btn" data-al-toggle="${panel}" aria-expanded="false" title="${label}" aria-label="${label}">${ALONG_ICONS[icon]}${value}</button>`
      : `<span class="al-item" role="img" title="${label}" aria-label="${label}">${ALONG_ICONS[icon]}${value}</span>`;
  }

  // One rally: road, driving time, and what lies along it. `dot` marks it with its colour on the
  // map (only needed when the trip has several rallies); `i` keeps its name lists apart.
  function alongLegHtml(leg, kind, a, b, dot, i) {
    const route = `${a.name} → ${b.name}`;
    const items = [];
    const panels = [];
    const names = (key, list, countKey, textKey) => {
      if (!list.length) return;
      items.push(alongItem(key, num(list.length), tr(countKey, { n: list.length }), `${key}-${i}`));
      panels.push(`<p class="along-detail" data-al-panel="${key}-${i}" hidden>${tr(textKey, { names: esc(list.join(", ")) })}</p>`);
    };
    if (!leg.measured) {
      items.push(alongItem("road", `≈ ${fmtKm(leg.km)}`, `${route} · ${tr("along.estimated", { km: fmtKm(leg.km) })}`));
      items.push(alongItem("info", "", tr("along.pending")));
    } else {
      items.push(alongItem("road", fmtKm(leg.km), `${route} · ${fmtKm(leg.km)}`));
      if (leg.drivingMin !== null) {
        items.push(alongItem("clock", fmtDuration(leg.drivingMin), cap(tr("along.driving", { time: fmtDuration(leg.drivingMin) }))));
      }
      names("park", leg.parks, "count.parks", "along.parks");
      names("unesco", leg.unesco, "count.unesco", "along.unesco");
      if (leg.coastKm) items.push(alongItem("coast", fmtKm(leg.coastKm), tr("scenic.coast", { km: fmtKm(leg.coastKm) })));
      const highest = leg.maxElevation !== null ? tr("along.highest", { n: leg.maxElevation }) : "";
      if (leg.mountainKm) {
        const above = tr("scenic.mountains", { km: fmtKm(leg.mountainKm) });
        items.push(alongItem("mountain", fmtKm(leg.mountainKm), highest ? `${above} · ${highest}` : above));
      } else if (highest) {
        items.push(alongItem("mountain", `${num(leg.maxElevation)} m`, cap(highest)));
      }
      if (NO_SITE_LOOKUP.has(a.country) || NO_SITE_LOOKUP.has(b.country)) {
        items.push(alongItem("info", "", cap(tr("along.europeOnly"))));
      }
    }
    const mark = dot ? `<i class="al-dot ${kind}" title="${esc(route)}"></i>` : "";
    return `<li><div class="al-row">${mark}${items.join("")}</div>${panels.join("")}</li>`;
  }

  // The weather where you stop between rallies, for the month you arrive.
  function alongStopHtml(s, arrive, leave) {
    const w = R.weatherFor(climateData, s.id, arrive);
    const when = leave && leave !== arrive ? `${fmtDay(arrive)} – ${fmtDay(leave)}` : fmtDay(arrive);
    const items = [alongItem("pin", `<span class="al-place">${esc(s.name)}</span>`, `${s.name}, ${when}`)];
    if (w && monthWeather(w)) {
      const words = cap(tr("along.weather", { weather: monthWeather(w), month: monthName(w.month, "long"), period: climateData.period }));
      if (w.t !== null) items.push(alongItem("temp", `${Math.round(w.t)} °C`, words));
      if (w.sun !== null) items.push(alongItem("sun", `${num(w.sun)} h`, words));
      if (w.rain !== null) items.push(alongItem("rain", tr("count.days", { n: Math.round(w.rain) }), words));
    } else {
      items.push(alongItem("info", "", tr("along.noWeather")));
    }
    return `<li><div class="al-row">${items.join("")}</div></li>`;
  }

  function alongHtml(t) {
    const f = facts.get(t.id);
    if (!f) return "";
    const n = t.legs.length;
    const items = [];
    t.legs.forEach((r, i) => {
      items.push(alongLegHtml(f.legs[i], legKind(t, i), stations.get(r.from), stations.get(r.to), n > 1, i));
      if (i < n - 1) items.push(alongStopHtml(stations.get(r.to), r.return, t.legs[i + 1].pickup));
    });
    // A one-way trip ends somewhere new, so the weather you arrive to is worth a line as well.
    if (t.type === "oneway") items.push(alongStopHtml(stations.get(lastLeg(t).to), lastLeg(t).return, null));
    const credits = [
      routeData && tr("along.creditRoutes", { link: OSRM }),
      climateData && tr("along.creditWeather", { link: OPEN_METEO }),
    ].filter(Boolean);
    // The last row is about the whole trip: the driving per day, and where the figures come from.
    const whole = [];
    if (f.drivingMinPerDay !== null) {
      const words = tr("along.summary", { perDay: fmtDuration(f.drivingMinPerDay), total: fmtDuration(f.drivingMin) });
      whole.push(alongItem("clock", tr("along.perDay", { time: fmtDuration(f.drivingMinPerDay) }), words));
    }
    if (credits.length) whole.push(alongItem("info", "", cap(tr("transit.sources")), "sources"));
    if (whole.length) {
      items.push(
        `<li><div class="al-row">${whole.join("")}</div>` +
        (credits.length ? `<p class="wh-credit" data-al-panel="sources" hidden>${tr("along.sources", { list: credits.join(", ") })}</p>` : "") +
        "</li>"
      );
    }
    return `<section class="along" aria-label="${esc(tr("along.title"))}"><ol class="along-list">${items.join("")}</ol></section>`;
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
    if (!retry && whOpen && mode === settings.homeMode) {
      closeWayHome(); // a second click on the open one folds it away
    } else {
      settings.homeMode = mode;
      saveSettings();
      openWayHome();
      renderWayHome(t);
    }
    $("results").querySelector(`.wh-tab[data-mode="${mode}"]`)?.focus(); // keep keyboard focus on the tabs
  }

  // ---------- Selection and playback ----------

  function selectTrip(id, { animate = true, scroll = false, fromPlay = false } = {}) {
    if (!fromPlay) stopPlay();
    const t = trips.find((x) => x.id === id);
    if (!t) return Promise.resolve();
    if (id !== selectedId) closeWayHome(false);
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
    closeWayHome(false);
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
    $("playAll").textContent = tr(playing ? "map.pause" : "map.playAll");
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

  // The settings (costs, way home) stay folded away until the button in the header opens them.
  function showSettings(open) {
    $("settingsPanel").hidden = !open;
    $("settingsToggle").setAttribute("aria-expanded", String(open));
    if (open) $("settingsPanel").scrollIntoView({ block: "nearest" });
  }
  $("settingsToggle").addEventListener("click", () => showSettings($("settingsPanel").hidden));
  $("settingsDone").addEventListener("click", () => {
    showSettings(false);
    $("settingsToggle").focus();
  });

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
    const whDetails = e.target.closest("[data-wh-details]");
    if (whDetails) {
      whDetailsOpen = !whDetailsOpen;
      whDetails.setAttribute("aria-expanded", String(whDetailsOpen));
      whDetails.nextElementSibling.classList.toggle("open", whDetailsOpen);
      return;
    }
    const option = e.target.closest("[data-itinerary]");
    if (option) {
      chooseItinerary(Number(option.dataset.itinerary));
      return;
    }
    // A number in "Along the way" shows the names it counts; the info button shows the sources.
    const alToggle = e.target.closest("[data-al-toggle]");
    if (alToggle) {
      const panel = alToggle.closest(".along").querySelector(`[data-al-panel="${alToggle.dataset.alToggle}"]`);
      panel.hidden = !panel.hidden;
      alToggle.setAttribute("aria-expanded", String(!panel.hidden));
      return;
    }
    if (e.target.closest(".cost-opt")) return; // the insurance box; its "change" is handled below
    // Opening the cost details doesn't also select the trip.
    const costs = e.target.closest("[data-costs]");
    if (costs) {
      const id = costs.closest(".trip").dataset.id;
      const open = !openCosts.has(id);
      if (open) openCosts.add(id);
      else openCosts.delete(id);
      costs.setAttribute("aria-expanded", String(open));
      costs.nextElementSibling.classList.toggle("open", open);
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

  // The insurance box in any trip's cost details counts insurance in or out for all trips.
  $("results").addEventListener("change", (e) => {
    if (!e.target.matches("[data-insurance]")) return;
    const id = e.target.closest(".trip").dataset.id;
    settings.includeInsurance = e.target.checked;
    saveSettings();
    stopPlay();
    compute();
    // The list was redrawn (and re-sorted, by cost); stay on the box that was ticked.
    const box = $("results").querySelector(`[data-id="${CSS.escape(id)}"] [data-insurance]`);
    if (box) box.focus({ preventScroll: true });
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

  function showLandingStats() {
    const total = [...offers.values()].reduce((n, set) => n + set.size, 0);
    $("landingStats").textContent = tr("landing.stats", {
      rallies: tr("count.rallies", { n: total }),
      stations: tr("count.stations", { n: stations.size }),
      when: fetchedWhen(),
    });
  }

  function startLanding() {
    showLandingStats();
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
  const fetchedWhen = () =>
    I18n.dates({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(data.fetched_at));

  // "1,234 roadsurfer rallies · 56 Imoova relocations · updated 5 Jan, 08:00", and any provider that is behind.
  function showDataInfo() {
    const counts = providersInData.map((p) => {
      const n = offers.get(p).size;
      return PROVIDERS[p] ? tr(`data.count.${p}`, { n }) : tr("data.count.other", { n, provider: esc(p) });
    });
    const problems = Object.entries(sources).flatMap(([p, info]) => {
      const ageDays = (Date.now() - new Date(info.fetched_at).getTime()) / 86400000;
      const age = ageDays > 1 ? tr("data.daysOld", { n: Math.floor(ageDays) }) : "";
      const provider = esc(providerName(p));
      if (info.error) return [age ? tr("data.noAnswerOld", { provider, age }) : tr("data.noAnswer", { provider })];
      return age ? [tr("data.old", { provider, age })] : [];
    });
    $("dataInfo").innerHTML =
      `${counts.join(" · ")} · ${tr("data.updated", { when: esc(fetchedWhen()) })}` +
      (problems.length ? `<span class="stale">${problems.join(" ")} ${tr("data.runUpdate")}</span>` : "");
  }

  // The insurance choices name their price: "Plus, €15 a day".
  function labelInsurance() {
    const names = { 0: "costs.insurance.basic", 15: "costs.insurance.plus", 29: "costs.insurance.max" };
    for (const option of $("insurance").options) option.textContent = tr(names[option.value], { price: euros(Number(option.value)) });
  }

  // ---------- Language ----------

  // A language picked with the flag redraws every text in place: the choices in the form,
  // the selected trip and the map stay as they are.
  function relabel() {
    labelThemeToggle();
    updatePlayButton();
    labelInsurance();
    const home = $("home").value;
    fillHomeSelect();
    $("home").value = home;
    updateHomeLabels();
    const unticked = providerBoxes().filter((box) => !box.checked).map((box) => box.value);
    fillProviders();
    for (const box of providerBoxes()) box.checked = !unticked.includes(box.value);
    showDataInfo();
    updateOutputs();
    if (landing) {
      showLandingStats();
      return;
    }
    if ($("dateError").textContent) $("dateError").textContent = dateError();
    updateLegend();
    map.closePopup();
    renderList();
    renderRanking();
    drawBase();
    if (selectedId && trips.some((x) => x.id === selectedId)) selectTrip(selectedId, { animate: false });
  }
  I18n.onChange(relabel);

  showDataInfo();
  labelInsurance();
  updatePlayButton();
  fillHomeSelect();
  fillProviders();
  writeForm();
  if (landing) startLanding();
  else compute();
})();
