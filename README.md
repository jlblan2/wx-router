# Wx Router

Installable phone web app (PWA) that plans a boat route between two points and keeps
the boat inside the captain's sea-state limits.

## Using it
1. **Settings**: vessel name, length, freeboard, draft, cruise speed, and for eight points
   around the vessel (bow, starboard bow, starboard beam, starboard quarter, stern, port
   quarter, port beam, port bow, each covering 45°) the maximum seas (ft) and maximum
   sustained wind (kt) allowed from that direction.
   Also "steep, short seas": areas where waves are higher than a set height (default 6 ft)
   with a period at or under a set time (default 6 s) are avoided from any direction.
2. **Route**: set the start (My location, or Pick on chart), the destination (Pick on
   chart), and the departure date/time, then **Plan route**.
3. The result shows distance, time underway, ETA, each waypoint with course, worst seas
   and wind, and colours each leg green/amber/red against the limit. **Export GPX**
   sends the route to a chartplotter or nav app.
4. **When can you go?** Every departure hour in the forecast is checked for the whole
   passage. A go/no-go timeline shows which hours work, with the departure windows listed
   and the most comfortable departure offered. Tap a green hour to plan that departure.
   Departures whose arrival falls after the end of the forecast are shown as unknown.

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
- Land avoidance uses the forecast's own grid (roughly 5–25 km), so it will not see
  small islands, reefs, channels or shoals. **Draft is stored but not yet checked
  against depth** (needs a bathymetry source). Always check the route on a real chart.
- Uses combined significant wave height and mean direction; swell and wind waves are
  not checked separately yet.
- Length and freeboard are stored for future use (e.g. suggesting limits); they don't
  change the routing yet.

## Running it
Any static web host over HTTPS works (GitHub Pages, Netlify, Cloudflare Pages). Serve
this folder as-is, open it on the phone and use "Add to Home Screen".
Locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
