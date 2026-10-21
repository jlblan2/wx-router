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
