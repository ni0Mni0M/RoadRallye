// Languages: which one the page speaks, its texts (web/lang/*.js), its date and number formats,
// and the flag menu beside the moon. A first visit follows the browser's languages, else English;
// a language picked with the flag is remembered.
// Works as a plain <script> in the browser (window.I18n) and as a Node module (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(null);
  else root.I18n = factory(root);
})(typeof self !== "undefined" ? self : this, function (win) {
  "use strict";

  // Each language in its own name, and the locale its dates, numbers and euros are written in.
  const LANGUAGES = [
    { code: "en", name: "English", locale: "en-GB" },
    { code: "de", name: "Deutsch", locale: "de-DE" },
    { code: "fr", name: "Français", locale: "fr-FR" },
    { code: "es", name: "Español", locale: "es-ES" },
    { code: "it", name: "Italiano", locale: "it-IT" },
    { code: "nl", name: "Nederlands", locale: "nl-NL" },
    { code: "pl", name: "Polski", locale: "pl-PL" },
    { code: "pt", name: "Português", locale: "pt-PT" },
  ];
  const FALLBACK = "en";
  const STORAGE_KEY = "rally-finder-lang";
  const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

  // The first of the browser's languages the page has ("de-AT" counts as German), else English.
  function pickLanguage(wanted) {
    for (const tag of wanted || []) {
      const code = String(tag).toLowerCase().split(/[-_]/)[0];
      if (byCode.has(code)) return code;
    }
    return FALLBACK;
  }

  // Formatters are slow to make, so each one is kept per locale and options.
  const formatters = new Map();
  function cached(kind, locale, opts, make) {
    const key = `${kind}|${locale}|${JSON.stringify(opts || {})}`;
    if (!formatters.has(key)) formatters.set(key, make());
    return formatters.get(key);
  }
  const pluralRules = (locale) => cached("plural", locale, null, () => new Intl.PluralRules(locale));
  const numberFormat = (locale, opts) => cached("number", locale, opts, () => new Intl.NumberFormat(locale, opts));

  // One text with its {placeholders} filled in. Numbers are written the language's way ("1.234,5").
  // A text with plural forms ({ one, few, many, other }) takes the form that the language's
  // plural rules pick for params.n, or "other" when it has no such form.
  function fill(entry, locale, params) {
    const p = params || {};
    let text = entry;
    if (text && typeof text === "object") {
      const form = pluralRules(locale).select(typeof p.n === "number" ? p.n : 0);
      text = form in text ? text[form] : text.other;
    }
    return String(text).replace(/\{(\w+)\}/g, (whole, name) => {
      const value = p[name];
      if (value === undefined || value === null) return whole;
      return typeof value === "number" ? numberFormat(locale, { maximumFractionDigits: 2 }).format(value) : String(value);
    });
  }

  // ---------- The page's language ----------

  let current = FALLBACK;
  const listeners = [];
  const texts = () => (win && win.RALLY_TEXTS) || {};
  const language = () => byCode.get(current);
  const locale = () => language().locale;

  // The text for `key` in the page's language, falling back to English, then to the key itself.
  function t(key, params) {
    const own = texts()[current] || {};
    const entry = key in own ? own[key] : (texts()[FALLBACK] || {})[key];
    return entry === undefined ? key : fill(entry, locale(), params);
  }

  const dates = (opts) => cached("date", locale(), opts, () => new Intl.DateTimeFormat(locale(), opts));
  const numbers = (opts) => numberFormat(locale(), opts);
  const regions = () => cached("region", locale(), null, () => new Intl.DisplayNames([locale()], { type: "region" }));
  const lists = () => cached("list", locale(), null, () => new Intl.ListFormat(locale(), { type: "conjunction" }));

  // The texts written into index.html: data-i18n="key" sets the text, data-i18n-attr="title:key;…" attributes.
  function translatePage() {
    const doc = win.document;
    doc.documentElement.lang = current;
    doc.title = t("page.title");
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of doc.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of el.dataset.i18nAttr.split(";")) {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
    labelMenu();
  }

  function setLanguage(code) {
    if (!byCode.has(code) || code === current) return;
    current = code;
    try {
      win.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {
      // Blocked storage: the language lasts until the page is closed.
    }
    translatePage();
    for (const fn of listeners) fn(code);
  }

  // ---------- The flag menu ----------

  const toggle = () => win.document.getElementById("langToggle");
  const menu = () => win.document.getElementById("langMenu");
  const items = () => [...menu().querySelectorAll("[data-lang]")];

  function labelMenu() {
    if (!toggle()) return;
    const label = t("lang.button", { language: language().name });
    toggle().title = label;
    toggle().setAttribute("aria-label", label);
    menu().setAttribute("aria-label", t("lang.menu"));
    for (const item of items()) item.setAttribute("aria-checked", String(item.dataset.lang === current));
  }

  function openMenu() {
    menu().hidden = false;
    toggle().setAttribute("aria-expanded", "true");
    (items().find((i) => i.dataset.lang === current) || items()[0]).focus();
  }

  function closeMenu(refocus) {
    if (menu().hidden) return;
    menu().hidden = true;
    toggle().setAttribute("aria-expanded", "false");
    if (refocus) toggle().focus();
  }

  function setupMenu() {
    const doc = win.document;
    menu().innerHTML = LANGUAGES.map(
      (l) => `<button type="button" role="menuitemradio" data-lang="${l.code}" lang="${l.code}" aria-checked="false">${l.name}</button>`
    ).join("");
    toggle().addEventListener("click", () => (menu().hidden ? openMenu() : closeMenu(true)));
    menu().addEventListener("click", (e) => {
      const item = e.target.closest("[data-lang]");
      if (!item) return;
      closeMenu(true);
      setLanguage(item.dataset.lang);
    });
    menu().addEventListener("keydown", (e) => {
      const list = items();
      const at = list.indexOf(doc.activeElement);
      const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
      if (go !== undefined) {
        e.preventDefault();
        list[(go + list.length) % list.length].focus();
      } else if (e.key === "Escape") {
        e.stopPropagation(); // the page's Escape would also close the selected trip
        closeMenu(true);
      } else if (e.key === "Tab") {
        closeMenu(false);
      }
    });
    doc.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".lang")) closeMenu(false);
    });
  }

  function start() {
    let saved = null;
    try {
      saved = win.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      saved = null;
    }
    const nav = win.navigator;
    current = byCode.has(saved) ? saved : pickLanguage(nav.languages && nav.languages.length ? nav.languages : [nav.language]);
    if (toggle()) setupMenu();
    translatePage();
  }

  // index.html loads this at the end of <body>, so the page's elements are there already.
  if (win && win.document) start();

  return {
    LANGUAGES,
    pickLanguage,
    fill,
    t,
    locale,
    lang: () => current,
    setLanguage,
    onChange: (fn) => listeners.push(fn),
    dates,
    numbers,
    regions,
    lists,
  };
});
