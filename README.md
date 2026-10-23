# Wx Router

Installable phone web app (PWA) that plans a boat route between two points and keeps
the boat inside the captain's sea-state limits.

## Using it
1. **Settings**: vessel name, length, freeboard, draft, cruise speed, and for eight points
   around the vessel (bow, starboard bow, starboard beam, starboard quarter, stern, port
   quarter, port beam, port bow, each covering 45°) the maximum seas (ft) and maximum
   sustained wind (kt) allowed from that direction.
   Also a minimum water depth (ft): routes stay out of anything shallower.
   Also "steep, short seas": areas where waves are higher than a set height (default 6 ft)
   with a period at or under a set time (default 6 s) are avoided from any direction.
2. **Route**: set the start (My location, or Pick on chart), the destination (Pick on
   chart), and the departure date/time, then **Plan route**.
   **Waypoints**: answer Yes to "Add waypoints along the way?" and tap the chart for each
   one, in order, then Done. The route passes through them in that order; drag a numbered
   marker to move it or tap Remove in the list.
3. The result shows distance, time underway, ETA, each waypoint with course, worst seas
   and wind, and colours each leg green/amber/red against the limit. **Export GPX**
   sends the route to a chartplotter or nav app.
4. **When can you go?** Every departure hour in the forecast is checked for the whole
   passage. A go/no-go timeline shows which hours work, with the departure windows listed
   and the most comfortable departure offered. Tap a green hour to plan that departure.
   Departures whose arrival falls after the end of the forecast are shown as unknown.
   When no route fits, the app finds the path that goes over the limits least and lists
   each limit exceeded (seas or wind by direction, steep short seas, depth), by how much,
   where and when, with red dots on the chart.

5. **Print settings and route** (below Plan route) prints the vessel settings, all limits,
   a sketch of the route, the departure windows and the waypoint table.
6. **Clear** (top right of the chart) removes the start, destination and route.
7. **X** (top right) exits. Phones don't let a web app close itself, so if it stays open
   a "closed" screen appears; close it the usual way (swipe up on iPhone, Back on Android).

## How the planner works (`js/router.js`)
- Lays a lattice of candidate waypoints over a corridor either side of the direct line
  (about 30% of the distance each side).
- Downloads an hourly forecast for every lattice point (`js/providers.js`).
- Searches for the fastest path where, at the time the boat is on each leg, the seas
  and the wind never exceed the limit for the direction they hit the boat from. Among legal paths it prefers
  ones that stay further below the limits.
- Points with no wave data (land, or too close to shore for the forecast grid) are
  avoided. The start and destination are always allowed so marinas work.

## Forecast data
`js/providers.js` holds the forecast sources behind one interface:
- **Open-Meteo** (default): free marine forecast (wave height, direction, period) and wind,
  7 days, no key. Called directly from the phone.
- **Demo**: made-up weather to try the app with no connection.
Another service can be added as a new provider without touching the planner.

Open-Meteo's free service limits how many forecast points one connection may ask
for each minute. Points closer together than its model grids share one download,
long routes are paced to stay under the limit (the progress line says when it is
waiting), and a "limit exceeded" answer is waited out and retried automatically.
Forecasts are kept per point for an hour, so re-planning a nearby route only downloads
new points. The free service also caps each connection at about 10,000 points a day.
Entering an Open-Meteo subscription key in Settings switches to Open-Meteo's
subscriber servers (customer-api / customer-marine-api), which have no daily or
per-minute limit, and turns pacing off.

## Shortest safe route and currents
Every plan is the quickest route that stays within all the limits: seas and wind by
direction, steep seas, minimum depth, the sailing angle and cruising hours. Time on
each leg uses speed over ground in the forecast ocean current (Open-Meteo marine,
MeteoFrance SMOC model, about 8 km): the current along the course adds or subtracts,
and the boat crabs against the current across it; a leg whose cross-current is
stronger than the boat's speed is not used. With no current, quickest is shortest. A
tiny comfort term only chooses between equally quick routes. The best departure is
the one with the least time underway, then the calmest. The model current is not a
substitute for tidal-stream data close inshore. The route is the shortest on the
planner's grid of candidate waypoints, so it can be slightly longer than a perfectly
drawn line.

## Going around shallow water
Before the weather routing, each stretch (start, your waypoints, destination) is
checked for a straight deep-water way using NOAA depths. If the straight way crosses
water shallower than the minimum depth, the area around it is mapped as a grid of
depth cells and searched for the shortest deep-water path (coarse first, up to about
150 nm either side for long passages, then refined in finer cells). Its turns are
added as automatic course changes, and the weather corridor is laid along them, so a
passage like Palm Beach to the Dominican Republic goes through the Providence
Channels instead of across the Bahama Banks. If no deep-water way exists, the result
says so.

## Land and bridges
Depth data is sampled every so often, so very narrow land (a thin cay, the neck of
land at Glass Window on Eleuthera) can slip between samples. Every leg is therefore
also tested against a built-in coastline: GSHHG full resolution (about 100 m detail)
for 8°N to 45°N, 98°W to 59°W, which ships with the app in `data/coast/` as 1° tiles
and is loaded as needed, so the check never depends on an online service. A leg that
crosses the coastline is blocked whatever the land's width, and the deep-water path
around shallows is searched so it never crosses it (the search widens until it finds
the way round the end of a long island).

Where there is coast, legs are also tested against the OpenStreetMap coastline and
bridges (via the Overpass API) when that service answers: a leg that passes under a
fixed bridge is blocked unless the bridge's charted clearance is at least 1 ft more
than the air draft set in Settings (opening bridges are allowed). If the service
doesn't answer, the route says bridges couldn't be checked. Routes are rhumb lines
(constant course), so the line that is drawn, exported and steered is the line that
was checked.

The built-in coastline is from GSHHG 2.3.7 (Wessel and Smith), released under the
GNU LGPL; `data/coast/index.json` lists its tiles.

## Vessel type
Settings > Vessel type is Motor or Sail. For sail, legs pointing closer to the wind
than a set angle (default 45°), once the wind reaches a set speed (default 8 kt), are
avoided, so the route tacks or reaches instead of heading straight upwind. Legs leaving
the start and reaching the destination are exempt, since those are usually motored.

## Safe havens and anchorages
After each plan, Wx Router lists harbours, marinas and anchorages within 15 nm of the
route from OpenSeaMap chart data (via the Overpass API), and marks them on the chart.
Each anchorage is judged for a 12 hour stay from when the boat would get there:
NOAA high-resolution depths in 16 directions around it give the open water (fetch)
each way, and the forecast wind for that spot gives the direction and strength. An
anchorage with open water upwind and the shore within 1 nm downwind in 10 kt or more
is on a lee shore and is left out (listed separately with the reason). The rest get
High, Medium or Low confidence from how sheltered they stay, how far ahead the
forecast is, and the depth data. Any haven can be added as a waypoint.

## Cruising hours
Settings > Cruising hours can keep the boat off the water during set hours, for
example 18:00 until 08:00 (the phone's local time). A departure is only workable if it
leaves and arrives outside those hours. With your own waypoints, a passage too long
for one day stops overnight at a waypoint and continues when the no-cruise hours end;
the legs table shows each stop. The departure timeline marks hours ruled out only by
the cruising hours.

## Saved routes
Save this route keeps the start, waypoints and destination on the phone under a
name. Check now on a saved route reloads it and plans it from the next hour against
the latest forecast. Each check's best departure and number of workable departure
hours is remembered (the last 10), so the list shows whether conditions are getting
better or worse.

## Known limits of this first version
- Water depth comes from NOAA NCEI's DEM Global Mosaic (NOAA coastal and regional
  bathymetry, global data offshore). Wherever the route is within 3 nm of land, it
  switches to NCEI's highest-resolution coastal models (the 1/9 arc-second, about 3 m,
  Continuously Updated DEMs, from the "DEM All" service) and samples every 0.05 nm.
  Land is found by probing 1, 2 and 3 nm either side of each leg. Where no coastal model
  covers a spot, or that service can't be reached, the Global Mosaic depths are used and
  the result says so. Waypoints are checked first, then every leg the
  planner wants to use is sampled every 0.2 nm; shallow legs are blocked and the plan is
  rerun until every leg in the answer is checked. Those depths are referenced to about
  high water (MHW or NAVD88), not chart datum, the first and last 0.25 nm near the start
  and destination aren't checked, and small shoals or reefs can be missed. If the depth
  service can't be reached, the result says depth was not checked. Always check the
  route on a real chart.
- Rivers, sounds and harbours have no sea forecast. Waypoints there are used only when
  NOAA depth shows water at least the minimum depth, and only the wind limits apply
  there. Narrow or winding river channels can still be missed by the planner's grid;
  if a route can't be found, set that end at the river mouth or inlet.
- Land avoidance also uses the forecast's own grid (roughly 5–25 km).
- Uses combined significant wave height and mean direction; swell and wind waves are
  not checked separately yet.
- Length and freeboard are stored for future use (e.g. suggesting limits); they don't
  change the routing yet.

## Running it
Any static web host over HTTPS works (GitHub Pages, Netlify, Cloudflare Pages). Serve
this folder as-is, open it on the phone and use "Add to Home Screen".
Locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
