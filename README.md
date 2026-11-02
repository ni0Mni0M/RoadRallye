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
| Way home | Adds a "Getting home" panel to the selected trip, from the last drop-off to your home station (see below) |

Three-rally trips are rare with tight settings, because they need a rally between two far-away
stations that lines up with the other two. A bigger start radius, more waiting days, or a train
hop finds more of them.

Click a trip to see it animated on the map; **Play all** cycles through the list.
Click a green station on the map to list only trips that stop there. Each leg has a **Book** link
that opens roadsurfer's booking page for exactly that rally. Settings are remembered in the browser.

## Way home

Tick **Plan how to get home** and select a trip. The panel compares three ways back from the
last drop-off, and the chosen one is drawn on the map as a dashed line:

| Mode | What you get |
| --- | --- |
| Train & bus | Live connections from [Transitous](https://transitous.org/) leaving after your drop-off time: departure, arrival, changes and lines (e.g. RE30 · ICE 798 · S15). Pick one to see it on the map. Without the local server or a contact it falls back to a rough estimate from the distance. |
| Car | The real road route from the free OSRM server: distance, driving time without traffic, and fuel cost from your consumption and fuel price |
| Plane | The best-connected airports at both ends, a door-to-door estimate (getting to the airport, 2 h at airports, flight, getting home), and Skyscanner / Google Flights search links. It can't tell whether a flight actually runs that day. |

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

## How it works

- `scraper/fetch_rallies.py` calls the JSON endpoints behind `booking.roadsurfer.com/rally`:
  the station list, each station's rally destinations, and each route's date windows. Each
  request needs an `X-Requested-Alias` header naming the endpoint. The result is saved as
  `web/data/rallies.json` and `web/data/rallies.js`. A failed run leaves the old data in place.
- `scraper/fetch_airports.py` saves airports with scheduled flights near the stations
  (OurAirports, ranked by connections from the OpenFlights route list). `update-data.bat` runs it
  only when `web/data/airports.js` is missing.
- `web/matching.js` chains rallies into round trips (distances use the stations' coordinates).
- `web/wayhome.js` holds the way-home estimates and links; the car route is fetched in `app.js`.
- `serve.py` serves the site and forwards train and bus searches to Transitous (`/api/transit`).

## License

MIT, see `LICENSE`.
- `web/app.js` draws the filters, the list, and the Leaflet map.

This is roadsurfer's internal API, not a documented one, so it can change without notice.
Price and vehicle details are only shown on roadsurfer's booking page; rallies are usually
advertised from €129.

## Tests

```bat
node --test tests/matching.test.js tests/wayhome.test.js
```
