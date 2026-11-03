# Rally round trips

Finds round trips made of two or three one-way relocation rentals ("rallies") from roadsurfer
and Imoova: one rally from near home to somewhere far away, optionally a second rally onward to
another far-away station, then a last rally back to a station near home. Results are shown on a
web page with a map that animates each trip.

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
| Home | The station the radii are measured from. The number after each station, e.g. "Berlin (17)", is how many round trips it would have with the other filters as they are now |
| Start within | The first rally must start this close to home (0 = the home station only) |
| Return within | The last rally must end this close to home |
| Earliest pickup / Back by | The whole trip must fit between these dates |
| Rallies per trip | 2, 2 or 3, or only 3. In a three-rally trip the middle rally must also end outside the return area (otherwise you'd already be home) |
| Wait between legs | Days allowed between dropping off one van and picking up the next |
| Train hop between rallies | Lets the next rally start from a different station this far from where the previous one ended (e.g. arrive in Antwerp, take the train to Brussels). A roadsurfer station and an Imoova city less than 30 km apart always count as the same place ("Across town") |
| Rentals from | Which providers to use: roadsurfer, Imoova or both |
| Way home | Adds a "Getting home" panel to the selected trip, from the last drop-off to your home station (see below) |

Three-rally trips are rare with tight settings, because they need a rally between two far-away
stations that lines up with the other two. A bigger start radius, more waiting days, or a train
hop finds more of them.

Click a trip to see it animated on the map; **Play all** cycles through the list.
Click a station on the map for a small menu: **Set as home** (with how many round trips you'd get
from there) and, for the green stations, **Trips via ...** to list only trips that stop there.
An Imoova city next to a roadsurfer station sets that roadsurfer station as home. Each leg has a **Book** link
that opens the provider's booking page for exactly that rally. Settings are remembered in the browser.

## Providers

| | roadsurfer | Imoova |
| --- | --- | --- |
| What | roadsurfer's own rallies | A marketplace where many rental companies (Indie Campers, McRent, Siesta, roadsurfer USA, ...) list relocations |
| Dates | Fixed pickup and return day | Pick up on any day of a window, then a number of free days. Each possible pickup day is listed as its own rally, returned when the free days end. Extra paid days are not shown |
| Places | Stations with exact addresses | City centres; the depot address comes with the booking |
| Price | Not in the data (usually from €129) | Shown on each leg: booking fee plus the daily rate for the free days. Fuel, bond and extra days come on top |
| Coverage today | Europe and North America | Europe (few offers outside spring and autumn, none from Germany in November) and the USA |

roadsurfer USA also lists vans on Imoova. When roadsurfer has a rally on the same route around the
same days, only the rally is kept; the others are shown as "Imoova (roadsurfer van)".

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

- `scraper/fetch_rallies.py` runs each source and saves the result as `web/data/rallies.json` and
  `web/data/rallies.js`. When a source fails, its data from the last run is kept and the page
  says how old it is, so one broken source never empties the page.
  - `scraper/roadsurfer.py` calls the JSON endpoints behind `booking.roadsurfer.com/rally`: the
    station list, each station's rally destinations, and each route's date windows. Each request
    needs an `X-Requested-Alias` header naming the endpoint.
  - `scraper/imoova.py` asks the GraphQL API behind `imoova.com/deals` for every bookable
    relocation in Europe and the USA (a handful of requests), plus which of them are roadsurfer's.
- `web/matching.js` chains rallies into round trips (distances use the stations' coordinates).
- `web/app.js` draws the filters, the list, and the Leaflet map.
- `web/wayhome.js` holds the way-home estimates and links; the car route is fetched in `app.js`.
- `serve.py` serves the site and forwards train and bus searches to Transitous (`/api/transit`).

Both are internal APIs, not documented ones, so they can change without notice. Vehicle details
are only shown on the providers' booking pages.

## Tests

```bat
node --test tests/matching.test.js tests/wayhome.test.js
python -m unittest discover -s tests
```

## License

MIT, see `LICENSE`.
