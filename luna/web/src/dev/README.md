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
  *Reload* starts the scenario over with fresh data. A full page load inside the frame
  (sign-out redirect, update restart) keeps the data: the world is saved in
  `sessionStorage`, and only Reload / "Open on its own" wipe it.
- **Right:** what to check, a result box, and **Break things**: go offline, slow
  everything, expire the session, or make one request fail (500, 403, 409, hang,
  empty or garbled answer). Any request with no mock shows a red banner, and a handler
  that crashes shows "fake crashed: …" (a bug in the fake, never in the app).
  Each rule shows how many requests it caught. **Sign in as** switches Admin / Member /
  signed out for any scenario. "Recent requests" shows the answer when you click a row.
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

## Fault rules

`METHOD /path` matches that exact path (trailing slash ignored). No method matches every
method. `*` is a wildcard for any characters: `GET /api/v1/drives/*/files`. Add `?key=value`
to also require query pairs. Nothing is a substring match. Scenario faults may carry
`on: false` to be prepared but ticked on by the tester.

## Add fake endpoints

`fake/world.js` holds the in-memory state; `fake/handlers/<area>.js` registers
routes (`get("/api/v1/x/:id", ({ world, params, body, user }) => …)`; throw
errors with `fail(status, message)`). Import the file in `handlers/index.js`.
Handlers must **change the world** so actions stick.

**Answer what lunad answers.** Before changing a handler, read the matching Rust handler in
`crates/lunad/src/api/` and copy its checks, status codes, messages and JSON. Who may do
what comes only from `fake/policy.js` (a copy of lunad's `auth.rs` rules). Registering the
same method + pattern twice throws, and a fixed segment beats a `:param`, so the order in
`handlers/index.js` never matters. Jobs (`fake/jobs.js`) work like `jobs.rs`: a copy or
cross-drive move copies first and trashes the original last; a failure removes the partial copy.

`npm run states:coverage` reads the app's source (including URLs built by helpers) and lists
every METHOD + path the app calls that the fake does not answer, or answers with another method.

## Real lunad only

The fake can't stand in for live co-editing (collab WebSocket), the EuroOffice
editors or draw.io. Mark such scenarios with `realLunadOnly: "why"`.
