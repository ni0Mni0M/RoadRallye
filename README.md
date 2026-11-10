# Rally trips

Finds trips made of one-way relocation rentals ("rallies") from roadsurfer and Imoova, and shows
them on a web page with a map that animates each trip. There are two kinds of trip:

- **One-way** (the default): one rally from near home to somewhere else, or a chain of up to three
  rallies that keeps going. You get home another way.
- **Round trip**: one rally from near home to somewhere far away, optionally a second rally onward
  to another far-away station, then a last rally back to a station near home.

## Use it

1. **Get fresh data:** double-click `update-data.bat`. It downloads every current rally
   (about 4–5 minutes, a few hundred small requests at a slow pace) into `web/data/`.
   `python scraper\fetch_rallies.py --source imoova` updates only one source (seconds for Imoova).
2. **Open the site:** double-click `open-site.bat`. It starts a small local web server and opens
   <http://localhost:8765>. Close the black window to stop it.

Needs Python 3 (no extra packages). Opening `web/index.html` straight from disk also works,
but the map background may stay blank because OpenStreetMap only serves tiles to real web pages.

## Filters

| Filter | Meaning |
| --- | --- |
| One-way / Round trip | The kind of trip to look for. The filters below that a kind doesn't use are hidden, and each kind remembers its own "Rallies per trip" |
| Home | The station the radii are measured from. The number after each station, e.g. "Berlin (17)", is how many trips of the chosen kind it would have with the other filters as they are now |
| Start within | The first rally must start this close to home (0 = the home station only). One-way trips end outside this area |
| Return within | Round trips only: the last rally must end this close to home |
| Earliest pickup / Back by | The whole trip must fit between these dates. For one-way trips the second date is the "Latest drop-off" |
| Rallies per trip | One-way: 1, 1 or 2, or up to 3. Round trip: 2, 2 or 3, or only 3. In a three-rally round trip the middle rally must also end outside the return area (otherwise you'd already be home) |
| Wait between legs | Days allowed between dropping off one van and picking up the next. Hidden, like the train hop, while a one-way trip is a single rally |
| Train hop between rallies | Lets the next rally start from a different station this far from where the previous one ended (e.g. arrive in Antwerp, take the train to Brussels). A roadsurfer station and an Imoova city less than 30 km apart always count as the same place ("Across town") |
| Rentals from | Which providers to use: roadsurfer, Imoova or both |
| Costs | roadsurfer's rally fee and insurance level, the van's diesel use and the fuel price, for the cost estimates (no tolls). Imoova legs use their listed price instead of the rally fee and insurance |
| Way home | Adds a "Getting home" panel to the selected trip, from the last drop-off to the central station of your home city (see below) |

A one-way chain never loops: each of its rallies ends outside the start area (at least 30 km from
home) and away from every place the trip has already been. So Berlin → Madrid → Berlin is a round
trip and never shows up as a one-way trip. With more than one rally allowed, the shorter trips are
listed too: Berlin → Madrid as well as Berlin → Madrid → Lisbon.

Three-rally round trips are rare with tight settings, because they need a rally between two far-away
stations that lines up with the other two. A bigger start radius, more waiting days, or a train
hop finds more of them.

Click a trip to see it animated on the map; **Play all** cycles through the list. Green is the
first rally, orange a rally onward, and purple the rally back home, which only round trips have.
The selected trip also shows **Along the way**: for each rally the road distance, driving time,
countries, national parks and World Heritage sites passed, km by the sea or above 1,000 m and the
highest point; for each stop, and for the place a one-way trip ends at, the typical weather in the
month you're there; and the average driving
time per day. The parks (triangles) and World Heritage sites (diamonds) are marked on the map. The
map draws each rally as an arc, not the actual road, so the marks sit along the real road, not on the arc.
Click a station on the map for a small menu: its typical daytime highs for each month (the months of
your dates marked), **Set as home** (with how many trips you'd get
from there) and, for the green stations, **Trips via ...** to list only trips that stop there
(**Trips to ...** for one-way trips, which can also end there).
An Imoova city next to a roadsurfer station sets that roadsurfer station as home. Each leg has a **Book** link
that opens the provider's booking page for exactly that rally. Settings are remembered in the browser.

## Providers

| | roadsurfer | Imoova |
| --- | --- | --- |
| What | roadsurfer's own rallies | A marketplace where many rental companies (Indie Campers, McRent, Siesta, roadsurfer USA, ...) list relocations |
| Dates | Fixed pickup and return day | Pick up on any day of a window, then a number of free days. Each possible pickup day is listed as its own rally, returned when the free days end. Extra paid days are not shown |
| Places | Stations with exact addresses | City centres; the depot address comes with the booking |
| Price | Not in the data (usually from €129) | Shown on each leg: booking fee plus the daily rate for the free days. Fuel, bond and extra days come on top. US offers are listed in US$ and shown in euros at the ECB rate of the update day ("≈ €91"); the listed price is in the tooltip |
| Coverage today | Europe and North America | Europe (few offers outside spring and autumn, none from Germany in November) and the USA |

Each Imoova leg names the rental company whose van it is, e.g. "Imoova (Indie Campers van)". Most
Imoova offers are Indie Campers' (about 9 in 10 in November 2026). roadsurfer USA also lists vans on
Imoova. When roadsurfer has a rally on the same route around the same days, only the rally is kept;
the others are shown as "Imoova (roadsurfer van)".

Each trip card also shows an estimated cost (roadsurfer's rally fee and insurance or Imoova's listed
price, plus diesel for the van), the
kilometres a day you'd drive, and the countries on the way. **Lowest cost** sorts by it.

## Destinations ranking

Switch from **Trips** to **Destinations** to rank stations instead of listing trips. It uses the
same filters, so it answers "with my settings, where can I go?". **Where to go** ranks the places
your trips take you to: where round trips stop between rallies, and for one-way trips also where
they end. **Where to start** ranks the stations they start from.

| Rank by | What it means |
| --- | --- |
| Most departure dates | Different days you could leave on for that place |
| Most backup options | Ways back per outbound rally, if your first choice gets booked (round trips only) |
| Most trips | All matching trips to or through the station |
| Longest stay | Most days there between rallies (round trips only) |
| Most relaxed pace | Fewest km a day on its gentlest trip |
| Farthest from home, Most countries | How far it takes you, and how many countries you cross |
| Warmest, Sunniest, Fewest rainy days | Typical weather in the month you'd arrive (2024–2025 average) |
| Most scenic route | National parks, World Heritage sites, coast and mountains along the route, each shown |
| Cheapest trip, Cheapest per day | The estimated cost of its cheapest trip |
| New this week, Departing soonest | Rallies first seen in the last 7 days; the earliest departure |
| Favourites first | Your starred stations on top |
| Combined score | Pick several of the above; each station gets the average of its positions, with bars showing why |

Star a station to make it a favourite, tick it when you've been there, and filter by both. Click a
station to see its trips. The scenic score adds 3 points per national park, 2 per World Heritage
site and 1 per 20 km by the sea or above 1,000 m, and the row always lists what it found.

## Way home

Tick **Plan how to get home** and select a trip. The panel compares two ways back from the
last drop-off, and the chosen one is drawn on the map as a dashed line. A one-way trip ends far
from home, so this is where you see what getting back takes. The way back ends at the central
station of your home city (for example Berlin Hbf), not at the rental depot, which is often in a
suburb or the next town. The stations are listed in `web/centers.js`; a roadsurfer city missing
there falls back to the depot.

| Mode | What you get |
| --- | --- |
| Train & bus | Live connections from [Transitous](https://transitous.org/) leaving after your drop-off time: departure, arrival, changes and lines (e.g. RE30 · ICE 798 · S15). Pick one to see it on the map. Without the local server or a contact it falls back to a rough estimate from the distance. |
| Car | The real road route from the free OSRM server: distance, driving time without traffic, and fuel cost from your consumption and fuel price |

### Live train and bus times (Transitous)

Transitous is a free, community-run journey planner for open-source, non-commercial apps. Its
[usage policy](https://transitous.org/api/) asks every app to:

- send a contact (email or website) with each request. This app reads it from
  `config.local.json` (copy `config.example.json`). The file is in `.gitignore`, so it stays out
  of the published code, and only the local server (`serve.py`) sends it, never the browser.
- be open source: this project is MIT-licensed (see `LICENSE`). Testing before you publish is fine.
- stay light: `serve.py` caches each search for an hour and stops after 300 searches a day
  (Transitous asks apps above about 720 a day to talk to them first).
- show where the data comes from: the panel links to [transitous.org/sources](https://transitous.org/sources/).

Live times only work when the site is opened through `open-site.bat`, because the lookup goes
through the local server.

## Automatic updates

A Windows Task Scheduler task named **Rally data update** runs `update-data.bat /nopause` every
day at 7:00 (or at the next startup if the PC was off). A console window shows while it runs.
To change or remove it, open Task Scheduler, or in PowerShell:

```powershell
Unregister-ScheduledTask -TaskName "Rally data update"
```

## Versions and trying out big changes

Before every big change the current version is saved as a git tag (a named restore point, e.g.
`before-ranking`), and the change is built on its own branch in a second folder next to this
one (a git worktree). `main` stays the version you know until you decide to keep the change.

- **Compare side by side:** double-click `compare.bat`. This folder opens on port 8765, every
  branch folder on 8775, 8776, ... `compare.bat /list` only shows what it would start.
- **See all restore points:** `git tag`
- **Look at an old version:** `git switch --detach before-ranking`, and back with `git switch main`
- **Go back for good** (keeps the newer history, so it can be undone too):
  `git revert --no-edit before-ranking..main`

The rules for this are in `CLAUDE.md`.

## How it works

- `scraper/fetch_rallies.py` runs each source and saves the result as `web/data/rallies.json` and
  `web/data/rallies.js`. When a source fails, its data from the last run is kept and the page
  says how old it is, so one broken source never empties the page. It also notes the day each
  rally first appeared (`first_seen`), for "New this week".
  - `scraper/roadsurfer.py` calls the JSON endpoints behind `booking.roadsurfer.com/rally`: the
    station list, each station's rally destinations, and each route's date windows. Each request
    needs an `X-Requested-Alias` header naming the endpoint.
  - `scraper/imoova.py` asks the GraphQL API behind `imoova.com/deals` for every bookable
    relocation in Europe and the USA (a handful of requests), with the rental company of each.
  - `scraper/rates.py` reads the European Central Bank's daily euro rates for the other currencies
    in the data. If that fails, the rates from the last run are kept.
- `scraper/fetch_route_info.py` works out, once per station pair, the road route (OSRM), the
  countries crossed and the coast nearby (Natural Earth), height above sea level (Open-Meteo),
  national parks (Wikidata) and World Heritage sites (OpenStreetMap) within 10 km. Parks and World
  Heritage sites are only looked up in Europe, so North American routes score on coast and mountains only.
  Each site is saved with the position of its part nearest the road, for the map. Saved as
  `web/data/routes.json`; downloads are cached in `scraper/cache/`. Routes saved before positions
  were kept get them from that cache on the next run (`--positions-only` does just that, no downloads).
- `scraper/fetch_climate.py` saves typical monthly weather per station from Open-Meteo
  (`web/data/climate.json`).
- `web/matching.js` chains rallies into one-way trips and round trips (distances use the stations' coordinates).
- `web/ranking.js` turns those trips into per-station figures, costs and scenic scores.
- `web/wayhome.js` holds the way-home estimates and links; the car route is fetched in `app.js`.
- `web/centers.js` lists the central station of each roadsurfer city, where the way home ends.
- `web/app.js` draws the filters, the lists, and the Leaflet map.
- `serve.py` serves the site and forwards train and bus searches to Transitous (`/api/transit`).

Both are internal APIs, not documented ones, so they can change without notice. Vehicle details
are only shown on the providers' booking pages.

## Tests

```bat
node --test tests/matching.test.js tests/wayhome.test.js tests/ranking.test.js
python -m unittest discover -s tests
```

## License

MIT, see `LICENSE`. Data sources keep their own terms: OpenStreetMap and Transitous (ODbL),
Open-Meteo (CC BY 4.0), Wikidata (CC0), Natural Earth (public domain).
