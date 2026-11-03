# Rally round trips

Finds round trips made of two or three roadsurfer rallies (one-way relocation rentals): one rally
from near home to somewhere far away, optionally a second rally onward to another far-away
station, then a last rally back to a station near home. Results are shown on a web page with a
map that animates each trip.

## Use it

1. **Get fresh data:** double-click `update-data.bat`. It downloads every current rally
   (about 4–5 minutes, a few hundred small requests at a slow pace) into `web/data/`.
2. **Open the site:** double-click `open-site.bat`. It starts a small local web server and opens
   <http://localhost:8765>. Close the black window to stop it.

Needs Python 3 (no extra packages). Opening `web/index.html` straight from disk also works,
but the map background may stay blank because OpenStreetMap only serves tiles to real web pages.

## Filters

| Filter | Meaning |
| --- | --- |
| Home | The station the radii are measured from |
| Start within | The first rally must start this close to home (0 = the home station only) |
| Return within | The last rally must end this close to home |
| Earliest pickup / Back by | The whole trip must fit between these dates |
| Rallies per trip | 2, 2 or 3, or only 3. In a three-rally trip the middle rally must also end outside the return area (otherwise you'd already be home) |
| Wait between legs | Days allowed between dropping off one van and picking up the next |
| Train hop between rallies | Lets the next rally start from a different station this far from where the previous one ended (e.g. arrive in Antwerp, take the train to Brussels) |
| Costs | Rally fee, insurance level, the van's diesel use and the fuel price, for the cost estimates (no tolls) |
| Way home | Adds a "Getting home" panel to the selected trip, from the last drop-off to your home station (see below) |

Three-rally trips are rare with tight settings, because they need a rally between two far-away
stations that lines up with the other two. A bigger start radius, more waiting days, or a train
hop finds more of them.

Click a trip to see it animated on the map; **Play all** cycles through the list.
Click a green station on the map to list only trips that stop there. Each leg has a **Book** link
that opens roadsurfer's booking page for exactly that rally. Settings are remembered in the browser.

Each trip card also shows an estimated cost (rally fees, insurance and diesel for the van), the
kilometres a day you'd drive, and the countries on the way. **Lowest cost** sorts by it.

## Destinations ranking

Switch from **Trips** to **Destinations** to rank stations instead of listing trips. It uses the
same filters, so it answers "with my settings, where can I go?". **Where to go** ranks the places
your round trips stop at; **Where to start** ranks the stations they start from.

| Rank by | What it means |
| --- | --- |
| Most departure dates | Different days you could leave on for that place |
| Most backup options | Ways back per outbound rally, if your first choice gets booked |
| Most round trips | All matching trips through the station |
| Longest stay | Most days there between rallies |
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
last drop-off, and the chosen one is drawn on the map as a dashed line:

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

- `scraper/fetch_rallies.py` calls the JSON endpoints behind `booking.roadsurfer.com/rally`:
  the station list, each station's rally destinations, and each route's date windows. Each
  request needs an `X-Requested-Alias` header naming the endpoint. The result is saved as
  `web/data/rallies.json` and `web/data/rallies.js`. A failed run leaves the old data in place.
  It also notes the day each rally first appeared (`first_seen`), for "New this week".
- `scraper/fetch_route_info.py` works out, once per station pair, the road route (OSRM), the
  countries crossed and the coast nearby (Natural Earth), height above sea level (Open-Meteo),
  national parks (Wikidata) and World Heritage sites (OpenStreetMap) within 10 km.
  Saved as `web/data/routes.json`; downloads are cached in `scraper/cache/`.
- `scraper/fetch_climate.py` saves typical monthly weather per station from Open-Meteo
  (`web/data/climate.json`).
- `web/matching.js` chains rallies into round trips (distances use the stations' coordinates).
- `web/ranking.js` turns those trips into per-station figures, costs and scenic scores.
- `web/wayhome.js` holds the way-home estimates and links; the car route is fetched in `app.js`.
- `web/app.js` draws the filters, the lists, and the Leaflet map.
- `serve.py` serves the site and forwards train and bus searches to Transitous (`/api/transit`).

This is roadsurfer's internal API, not a documented one, so it can change without notice.
Price and vehicle details are only shown on roadsurfer's booking page; rallies are usually
advertised from €129.

## Tests

```bat
node --test tests/matching.test.js tests/wayhome.test.js tests/ranking.test.js
```

## License

MIT, see `LICENSE`. Data sources keep their own terms: OpenStreetMap and Transitous (ODbL),
Open-Meteo (CC BY 4.0), Wikidata (CC0), Natural Earth (public domain).
