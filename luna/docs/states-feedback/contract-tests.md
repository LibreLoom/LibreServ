# Spec: lunad response contract tests (plan item 1.8, finding 8)

Status: shipped. The recorder landed as `70528ac0` (`api/contract.rs`), the web test as `2cf62a89` (`src/dev/contract/`), and `fb8ca0a7`/`934c1b62`/`86b5161a` fixed the fake, so `KNOWN_GAPS` is empty and the drift items below (the `inspect` method, the `versions` shape) are fixed — the briefs and "What I found" stay as history. The fixture format and comparison rules here still describe the shipped code.

## What I found

**How `fixture.json` is made today.** `luna/crates/lunad/src/backup/cloud/fixture.rs` is `#[cfg(test)] mod fixture;`. Its `#[test] fn write_fixture()` builds a fixed value and writes it with `serde_json::to_string_pretty(..) + "\n"`. The path is `concat!(env!("CARGO_MANIFEST_DIR"), "/src/backup/cloud/fixture.json")`. The web side imports it as plain JSON (`src/lib/cloudRestore.test.js`). `luna/ci.sh` runs `cargo test --workspace` at line 35, before `npm test -- --run` at line 153. So one full `./ci run -profile luna` writes the file first and then has vitest read it.

**There is no shared `send()` helper.** About 12 modules each define their own `send`, `call` or `get_json`. But about 30 test routers in `api/*.rs` (all except `network.rs`) layer `crate::auth::guard` (`src/auth.rs:803`) through `Router::layer`. That middleware runs after routing, so `axum::extract::MatchedPath` (axum 0.8) is in the request's extensions and gives `/api/v1/drives/{drive_id}/backups/{id}/versions`. **The guard is the central hook**, under `#[cfg(test)]`.

`cfg(test)` is only on for lunad's own lib unit tests. `main.rs` and other crates link the lib without it, so only one process ever writes the file.

**One more drift the test will catch.** lunad registers `POST /api/v1/drives/{name}/inspect` (`api/drives.rs:105`), and the app calls it with `postJson` (`pages/FilesPage.jsx:484`). The fake registers it as `get(...)` (`fake/handlers/core.js:121`), so the app's POST gets a 501 from the fake today.

**The fake versions answer**, from `fake/handlers/files.js:674`, is `[{at, size, current: true}, {at, size}, …]`. lunad (`api/backup_folder.rs:540`) answers `[{at: null|int, size, mtime}]`. So the gaps are: `mtime` is missing and `current` is extra.

## Design decisions

1. **Where the fixture lives:** `luna/web/src/dev/contract/lunad-responses.json`.
   - The Rust side writes it at `concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/dev/contract/lunad-responses.json")`.
   - The web side never imports it into the app; only the test reads it.

2. **It stores shapes, not samples.** Tests run in parallel threads, and they return different values (`[]` in one test, a filled list in another; `at: null` in one, an integer in another). So each response becomes a shape, and shapes merge in a way that gives the same result in any order.
   - **Leaf:** `"boolean" | "null" | "number" | "string"`. A union is the sorted names joined by `|`, for example `"null|number"`. Integers and floats are both `number`.
   - **Object:** a JSON object with sorted keys. A key missing from at least one observed object gets a `?` suffix, for example `"private_owner?": "string"`.
   - **Array:** `[elementShape]`, the merge of every element seen. It is `[]` when only empty arrays were seen.
   - **Mixed compound:** `{"$oneOf": [<leaf-union string>, <object>, <array>]}`, listing only the parts that exist, in that order. Example: `{"$oneOf": ["null", {...}]}`.
   - **Top level:** `{"$comment": "...", "GET /api/v1/...": shape, ...}`, keys sorted, pretty-printed, ending in `\n`.
   - **Key format:** `"{METHOD} {MatchedPath}"`. Every method is recorded, not only GET.
   - **Recorded:** only 2xx responses whose `content-type` starts with `application/json` and whose body parses as JSON.
   - **Written:** only keys whose path starts with `/api/` or `/s/`, or equals `/health`.
   - Ids and timestamps cannot cause churn, because only types are stored.

3. **When it is written.** The Rust test harness has no "after all tests" hook. So after any merge that changes the in-memory map, the recorder rewrites the whole file from that map, under the mutex. Because the merge does not depend on order, the last write of a full run is the same on every run.
   - Writing happens only when `LUNA_CONTRACT_RECORD=1` is set. `luna/ci.sh` sets it for `cargo test --workspace` only, not for the `llvm-cov` rerun.
   - This way a filtered local `cargo test foo` never shrinks the file. Recording into memory always happens under `cfg(test)`, so the self-test does not depend on the env var.

4. **How the web test maps a fake route to a fixture key.** Both sides are reduced to positional placeholders:
   - axum: `{name}` becomes `{}`, `{*name}` becomes `{*}`.
   - fake: `:name` becomes `{}`.
   - So `GET /api/v1/drives/:id/backups/:bid/versions` and `GET /api/v1/drives/{drive_id}/backups/{id}/versions` both become `GET /api/v1/drives/{}/backups/{}/versions`.
   - If the path matches but the method does not, that is a "method mismatch" failure (the inspect case).
   - A fake route whose path is not in the fixture at all becomes `it.todo` ("no lunad test records it yet"). It shows up in the output but does not fail.

5. **What the fake answers against.** `baseWorld()` has empty `backups`, `jobs`, `tokens`, `access`, `albums` and `recents`. So the test calls each fake route against `createWorld()` plus `createWorld(s.seed)` for every scenario, and merges the fake's shapes with the same rules.
   - A per-route `CASES` table builds the concrete URL from each world. It returns `null` to skip a world, or `{skip: reason}` for routes that return file bytes.
   - Then the test compares the lunad shape with the fake shape.

6. **Comparison rules.** "Real" is the lunad shape from the fixture; "fake" is the merged fake shape. Paths read like `$`, `$.key`, `$[]` (no indexes, so allow-list entries stay stable).
   - A fake leaf type not in the real union fails. A real union accepts any of its members.
   - If real is only `"null"` (lunad tests only ever saw null), the type is unknown and anything is accepted. This counts as a weak check.
   - Object vs array vs leaf mismatch fails.
   - A fake key not in real fails as an "extra key". This catches `current`.
   - A required real key (no `?`) that the fake lacks, or that the fake only sometimes sends, fails as a "missing key". This catches `mtime`, `writable` and `caps`.
   - If either side's array was only ever empty, the element check is skipped and counted as weak.
   - Only `{skip}` cases and `it.todo` routes are left unchecked.

7. **Allow-list.** `contract/known-gaps.js` exports `[{ key, path, reason }]`.
   - `key` is the normalized key. `path` is a JSON path from rule 6, or `"*"` for the whole route.
   - Entries that no longer match any mismatch fail the test, so the list can't rot.
   - Every unlisted mismatch is printed as a paste-ready entry.

8. **Coverage order:**
   - **First:** every GET the fake registers. That is the list `scripts/states-coverage.mjs` builds from `handlerPatterns()`: about 65 routes across `core`, `files`, `settings`, `gallery` and `access`.
   - **Plus one POST:** `POST /api/v1/drives/{}/inspect`.
   - **Must check on the first run:** drives, drives/:id/summary and health, backups, drives/:id/backups (plus list and versions), private-backups/*, jobs, me/recents, auth/me, users, system/updates, cloud/backups and cloud/phrase.
   - Other POST, PUT, PATCH and DELETE routes are recorded by Rust now and checked by the web test later.

9. **Sequencing.**
   - The two briefs can run in parallel. The web test loads the fixture with `import.meta.glob`, so it typechecks even before the file exists.
   - Then the orchestrator does one full `./ci run -profile luna`, which writes the fixture and runs vitest against it.
   - That first run is expected to fail: the failures are the drift report. Commit the fixture separately as `test(luna): record lunad response shapes`.
   - Then either fix the handlers in a separate task (plan 1.8, finding 8) or paste the printed allow-list entries with reasons. Per AGENTS.md, the commit body must say what was red or allow-listed.

## Exact AGENTS.md wording

Replace the "Running tests" bullet that starts "Test runs rewrite" with this:

```
- Test runs rewrite `luna/web/testing/results.json`, `luna/crates/lunad/src/backup/cloud/fixture.json` and `luna/web/src/dev/contract/lunad-responses.json` (the JSON shapes lunad's API tests see; written only by a full `./ci run -profile luna`). Don't hand-edit them. Keep them out of feature commits unless regenerating them, and commit them separately as `test(luna): ...` or `chore(luna): ...`. If a lunad response changes shape, fix the fake lunad (`luna/web/src/dev/fake/`) in the feature commit, or add an entry with a reason to `luna/web/src/dev/contract/known-gaps.js`.
```

---

## Brief 1 (haiku): Rust shape recorder and wiring

````markdown
# Task: record lunad API response shapes for the web contract test

Repo: /home/plainskill/Projects/LibreServ. Read AGENTS.md first ("Running tests"). Do NOT run any test
runner (no cargo test, no ./ci). Allowed: `cargo check -p lunad --tests`, `cargo fmt --all`,
`cargo clippy -p lunad --tests -- -D warnings` (none of these run tests).

## Owned files (touch nothing else)
- NEW  luna/crates/lunad/src/api/contract.rs
- EDIT luna/crates/lunad/src/api/mod.rs
- EDIT luna/crates/lunad/src/auth.rs   (only the end of `pub async fn guard`, around line 909)
- EDIT luna/ci.sh                      (line 35 only)
- EDIT AGENTS.md                       ("Running tests" bullet only)

Do NOT create or edit luna/web/src/dev/contract/lunad-responses.json by hand. CI writes it.

## Background
`crate::auth::guard` is layered with `Router::layer` onto nearly every lunad API test router, so it runs after
routing and `req.extensions().get::<axum::extract::MatchedPath>()` holds the route pattern
(e.g. `/api/v1/drives/{drive_id}/backups/{id}/versions`). Hook a test-only recorder there. It turns each JSON
2xx body into a *shape* and merges shapes in a way that gives the same result in any order, so parallel test order never changes the file. Model:
luna/crates/lunad/src/backup/cloud/fixture.rs (test-only module, CARGO_MANIFEST_DIR path, pretty JSON + "\n").

## 1. api/mod.rs
Add next to the other `pub mod` lines:
```rust
#[cfg(test)]
pub(crate) mod contract;
```

## 2. api/contract.rs (new; the whole file is test-only through the cfg above)
Module doc: `//! Test-only: records the JSON shape of every 2xx response that passes the auth guard, keyed by
//! "METHOD /route/{pattern}". With LUNA_CONTRACT_RECORD=1 (set by luna/ci.sh) it writes
//! luna/web/src/dev/contract/lunad-responses.json, which the web contract test compares the fake lunad against.`

Contents:
- `const OUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/dev/contract/lunad-responses.json");`
- Shape type:
  ```rust
  #[derive(Clone, Debug, Default, PartialEq)]
  pub(crate) struct Shape {
      leaves: BTreeSet<&'static str>,                    // "boolean" | "null" | "number" | "string"
      object: Option<BTreeMap<String, (Shape, bool)>>,   // bool = optional (missing from some sample)
      array: Option<Option<Box<Shape>>>,                 // Some(None) = only empty arrays seen
  }
  ```
- `pub(crate) fn shape_of(v: &Value) -> Shape`: Null/Bool/Number/String become a single leaf. Object becomes `object` with
  every key `(shape_of(child), false)`. Array becomes `array = Some(elements.fold(merge))`, or `Some(None)` when empty.
- `pub(crate) fn merge(a: &mut Shape, b: Shape)`: union `leaves`.
  - Objects: if only one side has an object, take it as is. If both do, take the union of keys. A key on both sides
    gets `(merged shape, opt_a || opt_b)`. A key on one side only gets `(its shape, true)`.
  - Arrays: if only one side has an array, take it. If both do, merge the elements, where `None` merged with x gives x.
  - The merge MUST give the same result in any order and grouping. Never depend on insertion order.
- `pub(crate) fn to_json(s: &Shape) -> Value`: build Values from BTreeMaps (sorted).
  - Leaves only: `Value::String(leaves.join("|"))`, in BTreeSet order, so `"null|number"`.
  - Object part: an object whose keys are `name` or `name?` (when optional), values `to_json(child)`.
  - Array part: `[to_json(elem)]`, or `[]`.
  - Exactly one part present: that part. More than one: `{"$oneOf": [leaf string?, object?, array?]}` in that order.
- Global: `static RECORDED: OnceLock<Mutex<BTreeMap<String, Shape>>>`.
- `pub(crate) fn key_of(req: &axum::extract::Request) -> Option<String>`: from `MatchedPath`:
  `format!("{} {}", req.method(), matched.as_str())`.
- `pub(crate) async fn observe(key: Option<String>, response: Response) -> Response`:
  - Return `response` untouched unless `key` is Some, `status().is_success()`, and the `content-type` header
    starts with `application/json`.
  - Otherwise `let (parts, body) = response.into_parts();` then `axum::body::to_bytes(body, usize::MAX).await`.
  - On error, return `Response::from_parts(parts, Body::empty())` and skip recording.
  - On success, parse with `serde_json::from_slice::<Value>`. If it parses, call `record(&key, &value)`.
  - Always return `Response::from_parts(parts, Body::from(bytes))`.
  - Buffer the body BEFORE taking the mutex. Never hold the std Mutex across an `.await`
    (clippy `await_holding_lock` is a CI error).
- `fn record(key, value)`: lock (recover from poison with `unwrap_or_else(|p| p.into_inner())`), then merge
  `shape_of(value)` into the entry. If the stored shape changed and `std::env::var_os("LUNA_CONTRACT_RECORD").is_some()`,
  call `write_file(&map)` while still holding the lock.
- `fn write_file(map)`:
  - Build `serde_json::Map` by inserting in sorted order: first
    `"$comment": "Generated by lunad's API tests (crates/lunad/src/api/contract.rs). Do not edit; a full ./ci run -profile luna rewrites it."`,
    then every key whose path (the part after the first space) starts with `/api/` or `/s/`, or equals `/health`, mapped to `to_json(shape)`.
  - `create_dir_all(parent)`, write `to_string_pretty + "\n"` to `OUT.tmp`, then `rename` to `OUT`.
  - Panic with a clear message on IO error.
- `pub(crate) fn recorded(key: &str) -> Option<Value>`: the `to_json` of the stored shape, for tests.
- `#[cfg(test)] mod tests` inside the file:
  1. `merge_is_order_independent`: samples `json!([{"at":null,"size":1,"mtime":2}])`, `json!([])`,
     `json!([{"at":5,"size":1,"mtime":2,"extra":"x"}])`. Merge them in all 6 orders and assert equal `to_json`.
     Assert the result is `json!([{"at":"null|number","extra?":"string","mtime":"number","size":"number"}])`.
  2. `one_of_for_mixed_compounds`: merge `null` and `{"a":true}` and assert `{"$oneOf":["null",{"a":"boolean"}]}`.
  3. `guard_records_the_route_pattern` (`#[tokio::test]`):
     - Build an AppState exactly like the `fixture()` in src/api/backups.rs (tempdir, `db::open`,
       `DriveManager::new(shared_mock(), dir)`, `AppState::new`).
     - Route: `Router::new().route("/contract-probe/{id}", get(|| async { axum::Json(json!({"id":"x","n":1})) }))`.
     - Then `.layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::guard)).with_state(state)`.
     - `oneshot` a GET to `/contract-probe/abc`. A non-/api path is public in the guard.
     - Assert status 200 and that the body still parses to the same JSON.
     - Assert `recorded("GET /contract-probe/{id}") == Some(json!({"id":"string","n":"number"}))`.
     - Do NOT call `record`/`observe` with /api keys from tests: they would land in the fixture.
       The probe key is filtered out at write time.

## 3. auth.rs, end of `guard`
Replace:
```rust
    if is_public {
        return maybe_attach_csrf(next.run(req).await, issue_csrf, secure);
    }
    if req.extensions().get::<CurrentUser>().is_some() {
        return maybe_attach_csrf(next.run(req).await, issue_csrf, secure);
    }
```
with:
```rust
    if is_public || req.extensions().get::<CurrentUser>().is_some() {
        #[cfg(test)]
        let contract_key = crate::api::contract::key_of(&req);
        let response = next.run(req).await;
        #[cfg(test)]
        let response = crate::api::contract::observe(contract_key, response).await;
        return maybe_attach_csrf(response, issue_csrf, secure);
    }
```
Nothing else in the guard changes. Release builds are byte-for-byte the same behavior.

## 4. luna/ci.sh line 35
`cargo test --workspace` becomes `LUNA_CONTRACT_RECORD=1 cargo test --workspace`.
Do not touch the llvm-cov line: it reruns the same tests and must not rewrite the file.

## 5. AGENTS.md
Replace the "Running tests" bullet beginning "Test runs rewrite" with exactly:
- Test runs rewrite `luna/web/testing/results.json`, `luna/crates/lunad/src/backup/cloud/fixture.json` and `luna/web/src/dev/contract/lunad-responses.json` (the JSON shapes lunad's API tests see; written only by a full `./ci run -profile luna`). Don't hand-edit them. Keep them out of feature commits unless regenerating them, and commit them separately as `test(luna): ...` or `chore(luna): ...`. If a lunad response changes shape, fix the fake lunad (`luna/web/src/dev/fake/`) in the feature commit, or add an entry with a reason to `luna/web/src/dev/contract/known-gaps.js`.

## Acceptance criteria
- `cargo check -p lunad --tests` and `cargo check -p lunad` (non-test) both compile.
- `cargo clippy -p lunad --tests -- -D warnings` is clean. `cargo fmt --all -- --check` is clean.
- `contract` is unreachable from non-test builds (cfg(test) on the module and on both guard lines).
- No other test file changed. No fixture file created by hand.
- After the orchestrator's full CI run, `lunad-responses.json` contains
  `"GET /api/v1/drives/{drive_id}/backups/{id}/versions": [{"at": "null|number", "mtime": "number", "size": "number"}]`,
  and a second run leaves it unchanged (`git diff --exit-code`).

## Self-check (no tests)
1. `cargo check -p lunad --tests && cargo check -p lunad`
2. `cargo clippy -p lunad --tests -- -D warnings`, then `cargo fmt --all -- --check`
3. `git diff --stat`: only the five owned files.
4. Re-read `merge`: every branch treats a and b the same way (swap them mentally).
5. grep that no `.await` sits between `lock()` and the guard's drop in contract.rs.
Commit: `test(lunad): record API response shapes for the web contract test`. Say in the body that tests were not run.
````

---

## Brief 2 (sonnet): web contract vitest and allow-list

````markdown
# Task: contract test, fake lunad vs real lunad response shapes

Repo: /home/plainskill/Projects/LibreServ/luna/web. Read /home/plainskill/Projects/LibreServ/AGENTS.md first
(Frontend, Running tests). Do NOT run vitest/npm test/./ci. Allowed: `npm run typecheck`, `npm run lint`.

## Owned files (create only these; edit nothing else, including the fake handlers)
- luna/web/src/dev/contract/shape.js
- luna/web/src/dev/contract/cases.js
- luna/web/src/dev/contract/known-gaps.js
- luna/web/src/dev/contract/contract.test.js
Never create or edit `lunad-responses.json`; lunad's tests write it (see AGENTS.md).

## Fixture format (written by lunad, crates/lunad/src/api/contract.rs)
`{"$comment": "...", "GET /api/v1/drives/{drive_id}/backups/{id}/versions": <shape>, ...}`. Every method is
recorded. Shape grammar:
- Leaf union string, sorted and joined by "|": `"string"`, `"null|number"` (the names are boolean, null, number, string).
- Object: keys sorted. A `name?` key means lunad sometimes omits it.
- Array: `[elementShape]`, or `[]` when lunad tests only saw empty arrays.
- Mixed: `{"$oneOf": [leafString?, object?, array?]}`.
Ignore top-level keys that start with `$`.

## shape.js (pure, JSDoc-typed)
- `shapeOf(value)` and `mergeShapes(a, b)`, using the same rules as the Rust side:
  - Leaves: take the union.
  - Objects: when both sides have one, a key present on one side only becomes optional; when one side has none, take the other as is.
  - Arrays: merge the elements; empty contributes nothing.
  - The merge must give the same result in any order.
  Use an internal form `{leaves:Set<string>, object:Map<string,{shape,optional}>|null, array:{elem:Shape|null}|null}`.
- `parseFixtureShape(json)`: fixture JSON to the internal form. `toFixtureJson(shape)` does the reverse, and is used in messages.
- `normalizeKey(method, path)`: replace `{*x}` with `{*}`, then `{x}` with `{}`, then `:x` with `{}`; return `"METHOD path"`.
- `compareShapes(real, fake, path = "$")` returns `{ errors: [{path, message}], weak: [path] }`:
  1. If real is the leaf `null` alone (no object, no array): accept anything and push to `weak`.
  2. Each fake leaf not in real.leaves is an error: "fake sends <t>, lunad sends <describe(real)>".
  3. Fake object with no real object, or fake array with no real array, is an error: type mismatch.
  4. Both objects:
     - A fake key not in real is an error: "extra key `k` (lunad never sends it)".
     - A real required key that is missing in fake, or optional in fake, is an error:
       "missing key `k`", or "`k` missing from some fake answers".
     - Otherwise recurse into `path + "." + k`.
  5. Both arrays: if either elem is null, push `path + "[]"` to `weak`; else recurse into `path + "[]"`.

## cases.js
`export const CASES` is an object keyed by the fake's own pattern string as registered (e.g.
`"GET /api/v1/drives/:id/backups/:bid/versions"`). The value is either:
- `{ url: (world) => string | null, body?: (world) => object }`, where `null` skips that world (no suitable data), or
- `{ skip: "<reason>" }` for non-JSON answers (file bytes, previews, downloads, `/s/:token/file`, `form-image`,
  `forms/file`, `files/content`, `backups/:bid/download`, `gallery/preview`).

Cover EVERY route that `installFake(...).handlerPatterns()` lists with method GET.
- Read each handler in src/dev/fake/handlers/*.js to choose params and queries that make it answer 200.
  Examples: versions needs `?path=` plus a backup whose `target_drive` is the `:id`; files needs `?path=`; jobs/:id needs an existing job.
- Take ids from the world: `world.drives[0]?.id`, `world.backups.find(...)`, `world.jobs[0]?.id`, `world.tokens[0]?.id`.
- Also add `"POST /api/v1/drives/:name/inspect"` with a url built from a drive's `device`, so the method check
  runs (the fake only has GET, lunad and FilesPage.jsx use POST).

## known-gaps.js
```js
/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [ /* seed below */ ];
```
Seed it with only the gaps you can confirm by reading the handlers. Each reason cites plan item 1.8 finding 8 (luna/docs/states-feedback/plan.md):
- `GET /api/v1/drives/{}/backups/{}/versions` `$[].current`: the fake marks the current copy with `current: true`; lunad uses `at: null`.
- `GET /api/v1/drives/{}/backups/{}/versions` `$[].mtime`: the fake omits `mtime`.
- `POST /api/v1/drives/{}/inspect` `*`: the fake registers GET; the app sends POST, so the fake answers 501.
Do not guess others. The first CI run prints them.

## contract.test.js
- Imports: vitest, then `../fake/handlers/index.js`, `{ installFake }` from `../fake/engine.js`,
  `{ createWorld }` from `../fake/world.js`, `{ scenarios }` from `../scenarios/registry.js`, then local modules.
- Load the fixture without failing typecheck when the file is absent:
  `const found = /** @type {any} */ (import.meta.glob("./lunad-responses.json", { eager: true, import: "default" }));`
  `const fixture = found["./lunad-responses.json"];`
  If it is missing, one `it` fails with "lunad-responses.json is missing: a full ./ci run -profile luna writes it".
- Index the fixture by `normalizeKey`. Also index by normalized path alone, to list the methods lunad has for that path.
- Collect the fake shapes once (`beforeAll`). For `createWorld()` and then `createWorld(s.seed)` for every scenario:
  - `installFake({ world, scenario: {}, now: 0 })`.
  - For each case with a `url`, `fetch(url, { method, body })`.
  - For a 2xx JSON answer, merge `shapeOf(json)` into `fake[pattern]`. A world where the case returns `null` or a non-2xx answer adds nothing.
  - Collect non-2xx statuses for the report only.
  - Wrap each fetch in try/catch: a throw is recorded as "fake crashed: <message>".
- One `describe("fake lunad matches lunad's response shapes")`, with one `it` or `it.todo` per fake pattern from `handlerPatterns()` (GET) plus CASES entries for other methods:
  - No CASES entry: fail with "add a CASES entry for <pattern>".
  - `{skip}`: `it.skip(\`${pattern}: ${reason}\`)`.
  - Normalized key not in the fixture, but the path exists under another method: an error at path `*`,
    "method mismatch: fake <M>, lunad <list>".
  - Path not in the fixture at all: `it.todo(\`${key}: no lunad test records this response yet\`)`.
  - No world produced a 2xx answer: an error at path `*`, "fake never answered 200 (statuses: ...)".
  - Otherwise `compareShapes(parseFixtureShape(fixture[key]), fake[pattern])`.
  - Drop errors matched by KNOWN_GAPS (same key, and path equal or `"*"`). Assert that no errors remain.
  - The failure message lists each error, then the paste-ready line
    `{ key: "<key>", path: "<path>", reason: "TODO" },` for each.
- One `it("every known gap still exists")`: fail on KNOWN_GAPS entries whose key/path matched nothing this run.
  Collect matches in a module-level Set during the per-route tests; vitest runs `it`s in a file in order.
- One `describe("shape rules")` with unit cases for shape.js:
  - Merge is order-independent (3 samples, all orders).
  - `"null"`-only real accepts anything.
  - An extra key fails. A missing required key fails.
  - `[]` on either side is weak.
  - `normalizeKey("GET", "/a/:id/b/:bid")` equals `normalizeKey("GET", "/a/{drive_id}/b/{id}")`.
- Header comment (3 lines max): what it checks, where the fixture comes from, how to add a gap.

## Acceptance criteria
- Only the 4 owned files are new. No other file changed.
- `npm run typecheck` and `npm run lint` are clean.
- Every GET in `handlerPatterns()` has a CASES entry (check by reading; the test also enforces it).
- With the fixture absent, the suite reports exactly one clear failure, not a crash at import.
- The versions route, against a fixture containing `[{"at":"null|number","mtime":"number","size":"number"}]`, produces
  errors at `$[].current` and `$[].mtime`, and the seeded KNOWN_GAPS entries cover both.
- Expected on the first full CI run: red, with paste-ready entries. That is the drift report, not a bug in this task.
  Say so in the commit body.

## Self-check (no tests)
1. `npm run typecheck && npm run lint` in luna/web.
2. Diff the GET patterns from `grep -n '^get(' src/dev/fake/handlers/*.js` against the CASES keys (duplicates such as
   `/api/v1/private/orphans` appear twice in the handlers; one CASES entry covers them, since the first one registered wins).
3. Walk the versions example through `compareShapes` by hand and confirm the two error paths match KNOWN_GAPS.
4. Confirm that no file outside src/dev/contract/ changed (`git status`).
Commit: `test(luna): contract test for the fake lunad against lunad response shapes`. Say in the body that tests were not run.
````

---

## Risks to watch on the first two CI runs
- **Timing-dependent responses** (job status, health) could make a `?` or a `null|` union appear in one run and not the next. Check by running twice with `git diff --exit-code`. If a key flaps, fix that lunad test so it is deterministic.
- **Routes outside the guard** (`network.rs:69` builds its router without it) are never recorded. They show up as `it.todo`.
- **Body buffering** applies to every guarded JSON 2xx in lunad tests. A test that relies on a streamed JSON body erroring midway would behave differently. I found none, but watch the first run.

### Critical files for implementation
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/auth.rs
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/mod.rs
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/backup/cloud/fixture.rs
- /home/plainskill/Projects/LibreServ/luna/web/src/dev/fake/engine.js
- /home/plainskill/Projects/LibreServ/luna/ci.sh