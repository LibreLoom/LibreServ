# State gallery — the testing marathon harness

Dev-only. Runs the **real Luna web app** against a **fake lunad that lives in the
browser**, so every state and edge case can be reached, clicked through and
recorded without hardware, a daemon, or a terminal. Nothing here ships: `main.jsx`
loads it only when `import.meta.env.DEV`.

## Use it

```bash
cd luna/web && npm run dev          # then open http://localhost:3001/__states
```

- **Left:** every scenario, grouped by area, with a dot for pass / problem / retest.
- **Middle:** the real app in a frame. Phone / tablet / desktop, light / dark.
  *Reload* starts the scenario over with fresh data.
- **Right:** what to check, a result box, and **Break things**: go offline, slow
  everything, expire the session, or make one request fail (500, 403, 409, hang,
  empty or garbled answer). Any request with no mock shows a red banner.
- Keys (click outside the frame first): `j` / `k` next / previous, `p` passed,
  `f` write a problem, `r` reload.
- Results save to `luna/web/testing/results.json` (commit it; it is the shared
  progress record). A problem also stores the faults and the last 15 requests.
- Hot reload keeps working inside the frame, so fix → look → mark *Fixed, retest*.

## Add scenarios

Create `src/dev/scenarios/<area>.scenarios.js` (picked up automatically):

```js
export default [{
  id: "files/empty-drive",            // unique, area/slug
  area: "Files",
  title: "Drive with nothing on it",
  url: "/files",                      // start route
  check: ["Empty state explains what to do", "New menu still works"],
  seed: (w) => { w.summaries.d1.used_bytes = 0; },   // edit the fake world
  faults: [{ match: "GET /api/v1/drives/d1/files", mode: "slow:4000" }],
  now: Date.UTC(2026, 9, 18),         // optional frozen clock
}];
```

Axes to cover for each screen: data (none, one, many, huge, long names, unicode,
missing fields) · async (loading, slow, error, offline, partial failure, failure
at each step of a flow) · who (Admin, Member, signed out, session dies) · look
(phone, tablet, desktop, light, dark) · hardware (full, read-only, failing,
unplugged mid-copy).

## Add fake endpoints

`fake/world.js` holds the in-memory state; `fake/handlers/<area>.js` registers
routes (`get("/api/v1/x/:id", ({ world, params, body, user }) => …)`; throw
errors with `fail(status, message)`). Import the file in `handlers/index.js`.
Handlers must **change the world** so actions stick.

`npm run states:coverage` lists every `/api/v1` path the app calls that still has
no handler.

## Real lunad only

The fake can't stand in for live co-editing (collab WebSocket), the EuroOffice
editors or draw.io. Mark such scenarios with `realLunadOnly: "why"`.
