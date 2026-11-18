// Languages: every text list has all the English keys with the same {placeholders} and the plural
// forms its language needs, the page only asks for texts that exist, and a first visit picks the
// right language. Run: node --test tests/i18n.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I18n = require("../web/i18n.js");
const R = require("../web/ranking.js");

const WEB = path.join(__dirname, "..", "web");
const texts = Object.fromEntries(I18n.LANGUAGES.map((l) => [l.code, require(path.join(WEB, "lang", `${l.code}.js`))]));
const en = texts.en;

const forms = (entry) => (typeof entry === "object" ? Object.values(entry) : [entry]);
const namesIn = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const englishNames = (key) => [...new Set(forms(en[key]).flatMap((f) => namesIn(f).split(",")).filter(Boolean))].sort().join(",");

for (const { code, locale } of I18n.LANGUAGES.filter((l) => l.code !== "en")) {
  test(`${code} has every English text and nothing else`, () => {
    const missing = Object.keys(en).filter((k) => !(k in texts[code]));
    const extra = Object.keys(texts[code]).filter((k) => !(k in en));
    assert.deepEqual(missing, [], `missing in ${code}.js`);
    assert.deepEqual(extra, [], `not in en.js`);
  });

  test(`${code} keeps the placeholders of every text`, () => {
    for (const [key, entry] of Object.entries(texts[code])) {
      if (!(key in en)) continue;
      for (const form of forms(entry)) assert.equal(namesIn(form), englishNames(key), `${code}: ${key}`);
    }
  });

  test(`${code} has the plural forms its language needs`, () => {
    const rules = new Intl.PluralRules(locale);
    for (const [key, entry] of Object.entries(texts[code])) {
      if (typeof en[key] === "object") assert.equal(typeof entry, "object", `${code}: ${key} needs plural forms`);
      if (typeof entry !== "object") continue;
      assert.ok("other" in entry, `${code}: ${key} has no "other" form`);
      for (let n = 0; n <= 1000; n++) {
        const form = rules.select(n);
        assert.ok(form in entry, `${code}: ${key} has no "${form}" form (for ${n})`);
      }
    }
  });
}

test("English plural texts have a one and an other form", () => {
  for (const [key, entry] of Object.entries(en)) {
    if (typeof entry === "object") assert.deepEqual(Object.keys(entry).sort(), ["one", "other"], key);
  }
});

test("every text the page asks for is in en.js", () => {
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const asked = new Set([
    // Keys written out in app.js ("cost.total") and index.html (data-i18n, data-i18n-attr).
    ...[...app.matchAll(/"([a-z]+(?:\.[A-Za-z0-9]+)+)"/g)].map((m) => m[1]).filter((k) => !/\.(js|json|bat|py|html|com|org)$/.test(k)),
    ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(";").map((pair) => pair.split(":")[1].trim())),
    // Keys app.js puts together.
    ...Object.keys(R.METRICS).map((k) => `metric.${k}`),
    ...Object.values(R.METRICS).map((m) => `rankGroup.${m.group}`),
    "metric.favourites", "metric.combined", "page.title", "lang.button", "lang.menu",
    ...["chip", "map.trips", "menu.trips"].flatMap((p) => ["via", "to", "toOrVia"].map((v) => `${p}.${v}`)),
    ...["destinations", "starts"].flatMap((mode) => ["oneway", "round"].map((type) => `rank.what.${mode}.${type}`)),
    ...["train", "town"].flatMap((how) => ["SameDay", "Later"].map((when) => `between.${how}${when}`)),
    "data.count.roadsurfer", "data.count.imoova", "data.count.movacar", "empty.round3",
  ]);
  const missing = [...asked].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
});

test("a first visit takes the first browser language the page has, else English", () => {
  assert.equal(I18n.pickLanguage(["de-AT", "en-US"]), "de");
  assert.equal(I18n.pickLanguage(["sv-SE", "fr-CA", "de"]), "fr");
  assert.equal(I18n.pickLanguage(["pt-BR"]), "pt");
  assert.equal(I18n.pickLanguage(["PL"]), "pl");
  assert.equal(I18n.pickLanguage(["zh-CN", "ja"]), "en");
  assert.equal(I18n.pickLanguage([]), "en");
  assert.equal(I18n.pickLanguage(undefined), "en");
});

test("texts fill in their placeholders and pick the plural form of the language", () => {
  const days = { one: "{n} dzień", few: "{n} dni", many: "{n} dni", other: "{n} dnia" };
  assert.equal(I18n.fill(days, "pl-PL", { n: 1 }), "1 dzień");
  assert.equal(I18n.fill(days, "pl-PL", { n: 3 }), "3 dni");
  assert.equal(I18n.fill(days, "pl-PL", { n: 1.5 }), "1,5 dnia");
  // French counts 0 as singular, English doesn't.
  assert.equal(I18n.fill({ one: "{n} jour", other: "{n} jours" }, "fr-FR", { n: 0 }), "0 jour");
  assert.equal(I18n.fill(en["count.days"], "en-GB", { n: 0 }), "0 days");
  // Numbers are written the language's way; strings go in as they are.
  assert.equal(I18n.fill("{n} km · {place}", "de-DE", { n: 1234.5, place: "Köln" }), "1.234,5 km · Köln");
  // A missing form falls back to "other", a missing placeholder stays visible.
  assert.equal(I18n.fill({ one: "{n} day", other: "{n} days" }, "pl-PL", { n: 5 }), "5 days");
  assert.equal(I18n.fill("Via {place}", "en-GB", {}), "Via {place}");
});
