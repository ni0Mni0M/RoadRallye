(function () {
  "use strict";

  const M = window.RallyMatching;
  const W = window.WayHome;
  const data = window.RALLY_DATA;
  const $ = (id) => document.getElementById(id);

  const STORAGE_KEY = "rally-finder-settings-v1";
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

  // First leg is "out", last is "back", anything in between is "mid".
  const legKind = (i, n) => (i === 0 ? "out" : i === n - 1 ? "back" : "mid");

  // Stations a trip stops at between rallies (drop-off and, after a train hop, the next pickup).
  function stopsOf(t) {
    const stops = new Set();
    for (let i = 0; i < t.legs.length - 1; i++) {
      stops.add(t.legs[i].to);
      stops.add(t.legs[i + 1].from);
    }
    return stops;
  }

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

  for (const [name, z] of [["areas", 405], ["overview", 410], ["stations", 420], ["wayhome", 425], ["trip", 430]]) {
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

  if (!data || !Array.isArray(data.rallies)) {
    $("dataInfo").textContent = "No rally data yet.";
    $("results").innerHTML =
      '<li class="empty">Run <code>update-data.bat</code> (or <code>python scraper/fetch_rallies.py</code>) ' +
      "to download the current rallies, then reload this page.</li>";
    $("playAll").hidden = true;
    return;
  }

  // ---------- Data and settings ----------

  const stations = new Map(
    data.stations.filter((s) => typeof s.lat === "number" && typeof s.lon === "number").map((s) => [s.id, s])
  );
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
    legs: "2",
    sort: "start",
    wayHome: false,
    homeMode: "transit",
    dropoffTime: "12:00",
    carConsumption: 7,
    fuelPrice: 1.8,
    hideProviders: [],
  };
  const TIME_OF_DAY = /^\d\d:\d\d$/;
  const LEG_CHOICES = ["2", "2-3", "3"];
  const HOME_MODES = ["transit", "car"];

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
    if (!LEG_CHOICES.includes(s.legs)) s.legs = DEFAULTS.legs;
    if (!HOME_MODES.includes(s.homeMode)) s.homeMode = DEFAULTS.homeMode;
    s.wayHome = s.wayHome === true;
    if (!TIME_OF_DAY.test(s.dropoffTime)) s.dropoffTime = DEFAULTS.dropoffTime;
    for (const key of ["carConsumption", "fuelPrice"]) if (!(s[key] > 0)) s[key] = DEFAULTS[key];
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

  let settings = loadSettings();
  let allTrips = [];
  let trips = [];
  let shown = PAGE_SIZE;
  let selectedId = null;
  let via = null;
  let animToken = 0;
  let playToken = 0;
  let playing = false;

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
    "dropoffTime", "carConsumption", "fuelPrice",
  ];
  const NUMERIC = new Set(["startRadius", "returnRadius", "maxWait", "hopRadius", "carConsumption", "fuelPrice"]);

  function writeForm() {
    for (const key of FIELDS) $(key).value = settings[key];
    $("filters").elements.legs.value = settings.legs;
    $("wayHome").checked = settings.wayHome;
    for (const box of providerBoxes()) box.checked = !settings.hideProviders.includes(box.value);
    updateOutputs();
  }

  function readForm() {
    const next = {};
    for (const key of FIELDS) next[key] = NUMERIC.has(key) ? Number($(key).value) : $(key).value;
    next.home = homeById.get(next.home);
    next.hideProviders = providerBoxes().filter((box) => !box.checked).map((box) => box.value);
    next.legs = $("filters").elements.legs.value;
    next.wayHome = $("wayHome").checked;
    next.homeMode = settings.homeMode; // chosen with the tabs in the trip card, not the form
    if (!TIME_OF_DAY.test(next.dropoffTime)) next.dropoffTime = DEFAULTS.dropoffTime;
    for (const key of ["carConsumption", "fuelPrice"]) if (!(next[key] > 0)) next[key] = DEFAULTS[key];
    settings = next;
  }

  function updateOutputs() {
    const v = (id) => Number($(id).value);
    $("startRadiusOut").textContent = v("startRadius") === 0 ? "home station only" : fmtKm(v("startRadius"));
    $("returnRadiusOut").textContent = fmtKm(v("returnRadius"));
    $("maxWaitOut").textContent = v("maxWait") === 0 ? "same day only" : `up to ${plural(v("maxWait"), "day")}`;
    $("hopRadiusOut").textContent = v("hopRadius") === 0 ? "off" : `up to ${fmtKm(v("hopRadius"))}`;
    $("wayHomeOptions").hidden = !$("wayHome").checked;
  }

  let debounce;
  function onFilterChange() {
    updateOutputs();
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

  // Round trips from one home station with the current filters (the "via" filter comes on top).
  function tripsFrom(home, rallies) {
    const found = M.findRoundTrips({ stations: data.stations, rallies }, {
      home,
      startRadiusKm: settings.startRadius,
      returnRadiusKm: settings.returnRadius,
      hopRadiusKm: settings.hopRadius,
      earliest: settings.earliest,
      latest: settings.latest,
      maxWaitDays: settings.maxWait,
      maxLegs: settings.legs === "2" ? 2 : 3,
      sort: settings.sort,
    });
    return settings.legs === "3" ? found.filter((t) => t.legs.length === 3) : found;
  }

  // How many round trips each station in the home list would have with the current filters ("Berlin (17)").
  // Counting all of them takes up to a few hundred ms, so it runs in short slices, and only again
  // when a filter other than the home station changed.
  const homeCounts = new Map();
  let countKey = "";
  let countToken = 0;

  function countHomes(error) {
    const key = JSON.stringify([
      error, settings.startRadius, settings.returnRadius, settings.hopRadius, settings.earliest, settings.latest,
      settings.maxWait, settings.legs, settings.hideProviders,
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

  function compute() {
    let error = "";
    if (!settings.earliest || !settings.latest) error = "Pick both dates.";
    else if (settings.latest < settings.earliest) error = "The back-by date is before the earliest pickup.";
    $("dateError").textContent = error;

    allTrips = error ? [] : tripsFrom(stations.get(settings.home), visibleRallies());
    countHomes(error);
    $("legendMid").hidden = settings.legs === "2";
    $("legendHome").hidden = !settings.wayHome;

    if (via !== null && !allTrips.some((t) => stopsOf(t).has(via))) via = null;
    trips = filterVia(allTrips);
    shown = PAGE_SIZE;

    const keepSelection = selectedId && trips.some((t) => t.id === selectedId);
    renderList();
    drawBase();
    if (keepSelection) selectTrip(selectedId, { animate: false });
    else clearSelection();
  }

  const filterVia = (list) => (via === null ? list : list.filter((t) => stopsOf(t).has(via)));

  function setVia(id) {
    via = id;
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
    const n = t.legs.length;
    const parts = t.legs.map((r, i) => {
      const wait = i > 0 && t.waits[i - 1] > 0 ? seg("wait", t.legs[i - 1].return, r.pickup) : "";
      return wait + seg(legKind(i, n), r.pickup, r.return);
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
      body += legHtml(legKind(i, n), r);
    });
    const waitFact = t.waitDays === 0 ? "no waiting" : `${plural(t.waitDays, "day")} waiting`;
    const legsFact = n === 3 ? "3 rallies · " : "";

    return (
      `<li class="trip${t.id === selectedId ? " selected" : ""}" data-id="${esc(t.id)}" tabindex="0">` +
      `<h3>${title}</h3>` +
      body +
      `<p class="facts">${plural(t.totalDays, "day")} · ${legsFact}${waitFact} · ends ${fmtKm(t.endKm)} from home</p>` +
      timelineHtml(t) +
      "</li>"
    );
  }

  function renderList() {
    const n = trips.length;
    const threes = trips.filter((t) => t.legs.length === 3).length;
    $("resultCount").textContent = !n
      ? "No round trips"
      : settings.legs === "2-3"
        ? `${plural(n, "round trip")} · ${threes} with 3 rallies`
        : plural(n, "round trip");
    $("viaChip").innerHTML =
      via === null
        ? ""
        : `<span class="chip">Via ${esc(stations.get(via).name)}<button type="button" id="clearVia" aria-label="Show trips via all destinations">×</button></span>`;

    if (!n) {
      $("results").innerHTML = $("dateError").textContent
        ? ""
        : settings.legs === "3"
          ? '<li class="empty">No trips with 3 rallies match. They need two far-away rallies that line up, ' +
            "so try a bigger start radius, more days between legs, or a train hop.</li>"
          : '<li class="empty">Nothing matches yet. Try a later back-by date, a bigger return radius, ' +
            "more days between legs, or a train hop.</li>";
      return;
    }
    const rest = n - shown;
    $("results").innerHTML =
      trips.slice(0, shown).map(tripHtml).join("") +
      (rest > 0 ? `<li class="more"><button type="button" id="showMore">Show ${Math.min(PAGE_SIZE, rest)} more</button></li>` : "");
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
    ring(settings.returnRadius, COLORS.back);
    if (settings.startRadius > 0) ring(settings.startRadius, COLORS.out);
    L.marker([home.lat, home.lon], { icon: homeIcon, keyboard: false, zIndexOffset: 500 })
      .bindTooltip(`Home: ${esc(home.name)}`, { direction: "top", offset: [0, -14] })
      .addTo(layers.home);

    // Faint lines for every route used by the current trips.
    const routes = new Map();
    for (const t of trips) {
      t.legs.forEach((r, i) => {
        const kind = legKind(i, t.legs.length);
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
      const role = km <= settings.startRadius ? "out" : km <= settings.returnRadius ? "back" : "far";
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
      const tripsLine = n ? `<br>${plural(n, "round trip")} via here${via === s.id ? " (filtered)" : ""}` : "";
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

  // The menu a click on a station opens: make it the home station, or list only the trips that stop there.
  function stationMenu(s, viaCount) {
    const target = homeFor(s);
    const count = homeCounts.get(target.id);
    const asHome = count === undefined ? "counting…" : plural(count, "round trip");
    const source = providersInData.length > 1 ? ` · ${esc(providerName(providerById.get(s.id)))}` : "";
    const lines = [`<p><strong>${esc(s.name)}</strong>${source}</p>`];
    if (target.id === settings.home) {
      lines.push("<p>Your home station</p>");
    } else {
      const who = target.id === s.id ? "As home" : `${esc(target.name)} as home`;
      lines.push(`<p>${who}: ${asHome}</p>`);
      lines.push(`<button type="button" data-action="home">Set ${target.id === s.id ? "" : esc(target.name) + " "}as home</button>`);
    }
    if (via === s.id) lines.push('<button type="button" data-action="via">Show all trips again</button>');
    else if (viaCount) lines.push(`<button type="button" data-action="via">Trips via ${esc(s.name)} (${viaCount})</button>`);

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
    const bounds = L.latLng(home.lat, home.lon).toBounds(settings.returnRadius * 2000);
    for (const t of trips) {
      for (const id of stopsOf(t)) {
        const s = stations.get(id);
        bounds.extend([s.lat, s.lon]);
      }
    }
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8, animate: !reduceMotion });
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
      legs.push({ kind: legKind(i, n), pts: arc(at(r.from), at(r.to)), ms: legMs });
    });

    const bounds = L.latLngBounds(legs.flatMap((l) => l.pts));
    if (settings.wayHome) bounds.extend([stations.get(settings.home).lat, stations.get(settings.home).lon]);
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
      const arriveColor = COLORS[legKind(i, n)];
      const arrive = `${esc(at(prev.to).name)} · ${fmtDay(prev.return)}`;
      if (next.from !== prev.to) {
        stopMarker(at(prev.to), arriveColor, arrive);
        stopMarker(at(next.from), COLORS[legKind(i + 1, n)], `${esc(at(next.from).name)} · ${fmtDay(next.pickup)}`);
      } else {
        stopMarker(at(prev.to), arriveColor, arrive + (t.waits[i] ? ` → ${fmtDay(next.pickup)}` : ""));
      }
    }
    const end = t.legs[n - 1];
    stopMarker(at(end.to), COLORS.back, `${esc(at(end.to).name)} · ${fmtDay(end.return)}`);

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
      van.getElement()?.setAttribute("data-leg", "back");
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
    const home = stations.get(settings.home);
    const crowKm = M.haversineKm(end, home);
    if (crowKm < 3) {
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
    itineraryChoice.set(transitKey(stations.get(lastLeg(t).to), stations.get(settings.home), leaveAfter), index);
    renderWayHome(t);
    $("results").querySelector(`.wh-option[data-itinerary="${index}"]`)?.focus();
  }

  // Puts an empty way-home panel into the selected card (re-rendering the list drops it).
  function attachWayHome(t) {
    for (const panel of $("results").querySelectorAll(".wayhome")) panel.remove();
    const el = $("results").querySelector(".trip.selected");
    if (el && settings.wayHome) el.insertAdjacentHTML("beforeend", '<section class="wayhome" aria-label="Getting home"></section>');
    renderWayHome(t);
  }

  function setHomeMode(mode, retry) {
    const t = trips.find((x) => x.id === selectedId);
    if (!t || !HOME_MODES.includes(mode)) return;
    if (retry) {
      const end = stations.get(lastLeg(t).to);
      const home = stations.get(settings.home);
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
    attachWayHome(t);
    if (el && scroll) el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    $("overview").hidden = false;
    return drawTrip(t, animate);
  }

  function clearSelection() {
    selectedId = null;
    animToken++;
    layers.trip.clearLayers();
    layers.wayHome.clearLayers();
    for (const panel of $("results").querySelectorAll(".wayhome")) panel.remove();
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
    if (e.target.closest(".wayhome")) return;
    if (e.target.closest("#showMore")) {
      shown += PAGE_SIZE;
      renderList();
      const t = trips.find((x) => x.id === selectedId);
      if (t) attachWayHome(t);
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
  compute();
})();
