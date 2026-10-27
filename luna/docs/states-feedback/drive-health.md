# Drive health and unopenable drives: implementation spec (stream C plus 3: `dashboard/drive-unmounted`)

Status: shipped 23 Oct 2026 (`5b63a6d5`, web `d0a0d757`/`919cbd3e`/`d7e36bf7`). "What the code does today" below describes the pre-fix code and stays as history; the health JSON contract is live.

## What the code does today

**Why warning and failed look the same.** lunad never sends `overall: "warning"`.
- `smart.rs` sets `overall` to `"passed"`, `"unknown"`, `"failed"` (when exit bits 2–3 are set), or the raw text after the `-H` line (for example `"FAILED!"`).
- The fake made up `"warning"` for d2 in `dashboard/drive-unhealthy`.
- `describeDriveHealth` (`luna/web/src/lib/driveHealth.js`) treats anything other than `"passed"` as the error case. So d2 shows "needs attention", the same as d1.
- The real design gap is the same: lunad has no warning level, and the web decides health from two raw numbers.

**Other bugs found:**
1. **Exit bit 2 is not a failing verdict.** The man page says bit 2 means "Some SMART or other ATA command to the disk failed". Only bit 3 ("returned DISK FAILING") and bit 4 ("prefail Attributes <= threshold") mean failing. Bit 5 means an attribute was past its threshold in the past. Bit 6 means the device error log has errors. Bit 7 means the self-test log has errors. Today `code & 0b1100` raises a false "failed" on bit 2. Bits 4–7 are ignored.
2. **lunad reads no pending, uncorrectable or airflow-temperature values.** That is attribute 197 `Current_Pending_Sector`, 198 `Offline_Uncorrectable`, and 190 `Airflow_Temperature_Cel` (many drives report that instead of 194).
3. **The system check in `system_health.rs` judges health its own way, and gets it wrong both ways.**
   - A report with `overall: "unknown"` becomes FAILED, "reported a hardware problem", which is a false alarm.
   - A worn drive becomes PASSED.
4. **lunad never checks that a drive is really mounted.** Nothing ever clears `mount_point`.
   - `drive_summary` says `mounted: true` whenever the path is non-empty. A dead mount leaves an empty folder on the system disk, so the summary reports the system disk's space.
   - `probe_writable` in `finish_comprehensive` passes by writing into that folder.
   - The `mounted: false` in the fake's `drive-unmounted` scenario is almost impossible on a real lunad, and the real dead-mount case shows wrong numbers.
   - The check should match `luna_mount_missing`: only Luna-owned paths under `mounts/` are checked, so test fixtures elsewhere keep working.
5. **lunad never sets drive state `"failed"`.** Only `as_is`, `readonly`, `missing` and `ejected` exist. The web's `"failed"` branches (DriveStatusPill "Problem", DriveHomeCard, needsYou `driveFailedItem`, the `drive-failed` scenario) are dead. Remove them; the new "can't open" state replaces them.
6. **Web gaps:**
   - The health query runs only for `as_is`. Going read-only is a classic sign of a failing drive.
   - `/files/:id` (`files/failing-drive`) shows no health at all.
   - The card shows a green "Ready" pill next to a red health pill.
7. **Flag only, don't fix:** uploads and file writes into a dead Luna mount would land on the system disk. That needs its own ticket; the same live-mount check can guard `files/` writes.

**Thresholds** (`smart.rs` constants, sent in the JSON so the web holds no numbers):
- **Temperature limit:** the drive's own limit if it reports one. smartctl `-l scttemp` prints `Min/Max recommended Temperature: 0/60 Celsius`; accept a max between 40 and 90. Otherwise use `TYPICAL_MAX_TEMP_C = 60`. That is the operating maximum on common hard-drive datasheets (some allow 65–70), so the copy says "most hard drives".
- **Temperature levels:**
  - `temp >= max` is **watch** ("too hot").
  - `max - 10 <= temp < max` is a **note** ("warm"). It doesn't change the verdict.
  - Below that is normal, with no signal.
  - So 48°C is normal and 55°C is warm. That answers "Is 48C too hot?".
- **Reallocated:** 1–99 is watch; `REALLOCATED_FAILING = 100` or more is failing. 100 is Luna's own line, not a SMART standard; say so in a code comment.
- **Pending or uncorrectable above 0:** failing. The drive could not read those spots, so files there may already be damaged.

---

## New `GET /api/v1/drives/:id/health` JSON (the contract all briefs share)

```json
{
  "available": true,
  "reason": null,
  "verdict": "failing",
  "overall": "failed",
  "model": "ST2000LM007",
  "serial": "ABC123",
  "temperature_c": 55,
  "temperature_max_c": 60,
  "temperature_max_source": "typical",
  "reallocated_sectors": 120,
  "pending_sectors": 0,
  "uncorrectable_sectors": 0,
  "status_bits": 8,
  "signals": [
    { "kind": "self_check_failed", "level": "failing", "value": null, "limit": null },
    { "kind": "reallocated_sectors", "level": "failing", "value": 120, "limit": 100 },
    { "kind": "temperature", "level": "note", "value": 55, "limit": 60 }
  ]
}
```

- `reason`: `null` when `available`. Otherwise `"not_a_hard_drive"` (SSD, USB stick, NVMe: the web says nothing) or `"no_report"` (a hard drive, but smartctl was missing, timed out, or gave unusable output).
- `verdict`: `"ok" | "watch" | "failing" | "unknown"`.
  - It is the highest signal level (`note` counts as ok).
  - With no watch or failing signal: `"ok"` if `overall == "passed"`, else `"unknown"`.
  - Always `"unknown"` when `!available`.
- `overall`: a closed set, `"passed" | "failed" | "unknown"`. Any `-H` text other than PASSED becomes `"failed"`, and so does exit bit 3.
- `temperature_max_source`: `"drive" | "typical"`.
- `signals[].kind` and its level:

| kind | level | when |
|---|---|---|
| `self_check_failed` | failing | `overall == "failed"` |
| `worn_past_limit` | failing | exit bit 4 |
| `pending_sectors` | failing | 197 raw > 0 (value = count) |
| `uncorrectable_sectors` | failing | 198 raw > 0 |
| `reallocated_sectors` | watch / failing | 1–99 / ≥100 (limit 100) |
| `worn_in_past` | watch | bit 5 |
| `error_log` | watch | bit 6 |
| `self_test_errors` | watch | bit 7 |
| `temperature` | note / watch | warm / hot (value = temp, limit = max) |

Signals are sorted failing first, then watch, then note, with the table order kept inside each level. `signals[0]` is the "top signal" the copy uses.

**`GET /api/v1/drives` and `GET /drives/:id/summary`** gain or fix `mounted: bool`. It is `false` when `mount_point` is empty, or when it is a Luna-owned path that isn't a live mount. Members get it too, because it isn't plumbing. A drive in state `as_is` or `readonly` with `mounted: false` is the **"can't open"** state.

---

## Brief L (haiku): lunad

**Owned files:**
- `luna/crates/lunad/src/drives/smart.rs`
- `luna/crates/lunad/src/drives/mod.rs` (one new pub fn)
- `luna/crates/lunad/src/api/drives.rs`
- `luna/crates/lunad/src/api/health.rs`
- `luna/crates/lunad/src/system/system_health.rs`

**Changes:**
1. **`smart.rs`:**
   - Add `#[derive(Serialize)] #[serde(rename_all="snake_case")]` enums `Verdict {Ok, Watch, Failing, Unknown}`, `Level {Note, Watch, Failing}` and `SignalKind` (the nine kinds above).
   - Add struct `Signal { kind, level, value: Option<i64>, limit: Option<i64> }`.
   - Add these fields to `DriveHealth`: `reason: Option<&'static str>` (serialize as string or null), `verdict`, `temperature_max_c: i64`, `temperature_max_source: &'static str`, `pending_sectors: Option<u64>`, `uncorrectable_sectors: Option<u64>`, `signals: Vec<Signal>`, plus a private `sct_max_c: Option<i64>` with `#[serde(skip)]`.
   - Add `fn empty(reason: Option<&'static str>) -> DriveHealth` and use it in `read()` and the tests in place of the three struct literals. `!applicable` gives `"not_a_hard_drive"`; a missing smartctl or unusable output gives `"no_report"`.
   - Add `"-l", "scttemp"` to the smartctl args.
   - In `parse`:
     - Read `Current_Pending_Sector` and `Offline_Uncorrectable` through `smart_raw`.
     - Read `Airflow_Temperature_Cel` only if 194 wasn't seen (194 wins whatever the line order).
     - Read `Min/Max recommended Temperature:` as `a/b Celsius`, keeping b only if `40..=90`.
     - Normalize the `-H` line: PASSED gives `"passed"`, anything else gives `"failed"`.
   - In `read`: replace `code & 0b1100` with `code & 0b1000` (bit 3 only forces `overall = "failed"`). Keep `status_bits` as it is. Call `judge(&mut health)` before returning, on every path.
   - Add pub `fn judge(h: &mut DriveHealth)`. It is pure: it fills `temperature_max_c` and `temperature_max_source`, `signals` (sorted) and `verdict` from the rules above. Constants: `TYPICAL_MAX_TEMP_C = 60`, `WARM_MARGIN_C = 10`, `REALLOCATED_FAILING = 100`.
2. **`drives/mod.rs`:** add `pub fn mount_is_live(&self, mount_point: &str) -> bool`. It returns `!mount_point.is_empty() && !(self.is_ours(p) && !self.mounter.is_mounted(p))`, the same logic as `luna_mount_missing`.
3. **`api/drives.rs`:**
   - Add `mounted: bool` to `DriveJson`, set in `list` from `state.drive_manager.mount_is_live(&mount_point)` before Members' `mount_point` is blanked.
   - In `drive_summary`, keep the `mount_point.is_empty()` branch but make it `!state.drive_manager.mount_is_live(&mount_point)`, so a dead mount returns `mounted: false` and null bytes.
4. **`api/health.rs` `compute`:** after `list_drives`, set `d.mount_point = String::new()` for each drive where `!state.drive_manager.mount_is_live(&d.mount_point)`, before calling `finish_comprehensive`.
5. **`system_health.rs`:**
   - Split the read-write row:
     - `drive.state == "readonly"`: `"Luna can't save new files to {label}."`, more: `"The drive is read-only."`
     - `mount_point` empty: `"Luna can't open {label}."`, more: `"Unplug it and plug it back in."`
   - Replace the SMART block with `if let Some((status, msg, more)) = smart_check(&label, &health)`. Details: `{drive_id, drive_label, verdict, signals}`.
   - Add a pure `pub(crate) fn smart_check(label:&str, h:&DriveHealth) -> Option<(&'static str, String, Option<String>)>`. It returns `None` when `!available` or the verdict is `Unknown`. `top` = `signals[0]`; t = temp; max = `temperature_max_c`.
     - **Ok** → PASSED `"{label} reported no hardware problems."`. More: `"It's {t}°C, which is normal for a hard drive."`, or for a temperature note `"It's {t}°C, close to the {max}°C it's made for."`, or `None` if there is no temperature.
     - **Watch** → WARNING, by top kind:
       - `reallocated_sectors` or `worn_in_past`: `"{label} is showing wear. Keep using it, and make sure it's backed up."`
       - `error_log`: `"{label} has logged read or write errors. Keep using it, and make sure it's backed up."`
       - `self_test_errors`: `"{label} failed a self-test. Keep using it, and make sure it's backed up."`
       - `temperature`: `"{label} is running hot ({t}°C). Move it somewhere cooler."`
       - More: `None`.
     - **Failing** → FAILED `"{label} is failing. Copy your files to another drive now."`. More, by top kind:
       - `self_check_failed`: `"Its own self-check failed."`
       - `worn_past_limit`: `"It's past its maker's wear limit."`
       - `pending_sectors` or `uncorrectable_sectors`: `"It can't read {n} spots on its disk."`
       - `reallocated_sectors`: `"{n} spots on its disk have worn out."`

**Rust unit tests to add:**
- In `smart.rs`, each with a realistic smartctl text block:
  - `parse_reads_pending_uncorrectable_and_airflow`, plus a case showing 194 wins over 190 in either order
  - `parse_reads_sct_recommended_max`; `0/0` and `-/-` are ignored
  - `parse_normalizes_failed_text` (`FAILED!` → `"failed"`)
  - `judge_ok_clean`
  - `judge_watch_few_reallocated` (4 → watch, limit 100)
  - `judge_failing_many_reallocated` (120)
  - `judge_failing_self_check`
  - `judge_failing_pending`
  - `judge_temperature_levels`: 48 gives no signal, 55 a note, 61 watch; with an SCT max of 70, 61 is a note and the source is `"drive"`
  - `judge_bit2_alone_is_ok`
  - `judge_bits_3_4_fail_and_5_6_7_watch`
  - `judge_unknown_without_report`; `read("")` gives reason `not_a_hard_drive`
  - `judge_unknown_when_overall_unknown_and_no_signals`
  - `signals_sorted_failing_first`
  - `health_json_has_contract_keys`: every top-level key above, through `serde_json::to_value`
- In `system_health.rs`:
  - `smart_check_maps_verdicts`: ok gives PASSED, watch gives WARNING, failing gives FAILED, unavailable or unknown gives None. Test the exact strings for one case each.
  - `comprehensive_unopened_drive_says_cant_open`: an `as_is` drive with empty `mount_point` gives the `"Luna can't open Photos."` message.
  - Re-check `comprehensive_marks_readonly_drive_failed` (the message changes; the status stays FAILED).
- In `api/drives.rs`:
  - `list_reports_dead_luna_mount_as_unmounted`: a drive whose `mount_point` is under `dir/mounts/drives/d1` gives `mounted: false`; after `mock.mount(..)` it gives `true`. Keep a handle to `shared_mock()`.
  - `summary_dead_mount_has_no_bytes`
  - `fixture_paths_outside_luna_mounts_stay_mounted` (`/mnt/d1` → `true`)

**Acceptance:**
- `/health` JSON matches the contract.
- No exit-bit-2-only false alarm.
- A dead Luna mount reads `mounted: false` in the list and summary, and "Luna can't open {label}." in the system check.
- `smart_check` and the web give the same verdict, because both read `verdict`.

**Scenarios closed (real side):** `dashboard/drive-unhealthy`, `files/failing-drive`, `dashboard/drive-unmounted`.

**Self-check:** `cargo check -p lunad --tests`. Don't run tests; they go through `./ci`.

---

## Brief W1 (sonnet): health copy, Needs you, dashboard

**Owned files:**
- `luna/web/src/lib/driveHealth.js` (+ `.test.js`)
- `luna/web/src/lib/needsYou.js` (+ `.test.js`)
- `luna/web/src/lib/drives.js`
- `luna/web/src/hooks/useNeedsYou.js` (+ test)
- new `luna/web/src/hooks/useDriveHealth.js`
- `luna/web/src/components/dashboard/NeedsYou.jsx` (+ test)
- `luna/web/src/components/dashboard/DriveHomeCard.jsx` (+ test)
- `luna/web/src/components/common/DriveStatusPill.jsx` (+ test)
- `luna/web/src/pages/DashboardNeedsYou.test.jsx`

**Changes:**
1. **`useDriveHealth(drive, isAdmin)`:**
   - Query key `["drive-health", drive.id]`, `retry: false`.
   - Enabled when `isAdmin && (state as_is || readonly) && drive.mounted !== false`.
   - Used by useNeedsYou, DriveHomeCard and FilesPage (W2), so there is one key and one set of options.
2. **`lib/drives.js`:**
   - Add `isUnopenable(drive)`: `(as_is||readonly) && drive.mounted === false`.
   - `isPresentDrive` drops `"failed"` and adds `&& drive.mounted !== false`.
3. **`describeDriveHealth(health)`:**
   - It reads only `verdict`, `reason`, `signals`, `temperature_max_*` and `overall`, never raw thresholds.
   - It returns `null` for `reason === "not_a_hard_drive"`. Otherwise it returns `{ verdict, pill:{variant,label}, summary, needsYou, rows, steps }`.
   - `health` undefined (loading): verdict `"checking"`, pill muted `"Checking health…"`, summary `"Checking this drive's health…"`, no rows.

   **Pills and summaries** (by verdict, then top signal `signals[0]`):

   | verdict / top | pill (variant: label) | summary |
   |---|---|---|
   | ok | success: `Healthy` | `This hard drive reported no problems.` |
   | watch: reallocated, worn_in_past | warning: `Showing wear` | `Still working. Keep using it, and make sure its files are backed up.` |
   | watch: error_log | warning: `Logged errors` | same as above |
   | watch: self_test_errors | warning: `Failed a self-test` | same as above |
   | watch: temperature | warning: `Running hot` | `Still working, but too hot. Move it somewhere cooler or give it more air.` |
   | failing (any) | error: `Failing` | `This drive is failing. Copy your files to another drive now.` |
   | unknown, `no_report` | muted: `Health unknown` | `Luna couldn't read this hard drive's health report.` |

   For `no_report`, InfoHint: `Hard drives keep a health report that Luna reads. Some USB cases don't pass it on. Luna can still use the drive, but it can't warn you early.`

   **`needsYou`:** `null` for ok, unknown and checking. Otherwise `{ tone, rank, title, detail }`; `title` is the text after the drive-name pill.
   - Failing: tone `"problem"`, rank 12, title `" is failing"`. Detail by top signal:
     - `self_check_failed`: `Its own self-check failed. Copy your files to another drive now.`
     - `worn_past_limit`: `It's past its maker's wear limit. Copy your files to another drive now.`
     - `pending_sectors` or `uncorrectable_sectors`: `It can't read {n} spots on its disk. Copy your files to another drive now.`
     - `reallocated_sectors`: `{n} spots on its disk have worn out. Copy your files to another drive now.`
   - Watch: tone `"warning"`, rank 70.
     - `reallocated_sectors`: title ` is showing wear`, detail `{n} spots on its disk have worn out. Keep using it, and make sure it's backed up.`
     - `worn_in_past`: title ` is showing wear`, detail `It went past its maker's wear limit once. Keep using it, and make sure it's backed up.`
     - `error_log`: title ` has logged errors`, detail `It recorded errors while reading or writing. Keep using it, and make sure it's backed up.`
     - `self_test_errors`: title ` failed a self-test`, detail `Its own test found a problem. Keep using it, and make sure it's backed up.`
     - `temperature`: title ` is running hot`, detail `It's {t}°C, above the {max}°C it's made for. Move it somewhere cooler.`

   **`rows`** (for W2's details, each `{key, label, hint, value}`):
   - Self-check:
     - Label `Drive's self-check`.
     - Hint: `Hard drives test themselves and report pass or fail.`
     - Value: `Passed`, `Failed` or `Not reported`.
   - Temperature (omit if null):
     - Label `Temperature`.
     - Value: `{t}°C · normal`, `{t}°C · warm` or `{t}°C · too hot`.
     - Source sentence: drive gives `This drive says it's made to run at up to {max}°C.`; typical gives `Most hard drives are made to run at up to {max}°C.`
     - Hint, normal: `Hard drives get warm while they work. {source}`
     - Hint, warm: `Close to its limit. {source} Keep air moving around it.`
     - Hint, hot: `Above its limit. {source} Heat wears a drive out faster.`
   - Replaced spots (if `reallocated_sectors != null`):
     - Label `Replaced spots`.
     - Hint: `Parts of the disk that wore out. The drive moved their data to spare space. A few is a warning sign, and the number usually grows. Luna treats 100 or more as failing.`
     - Value: `None`, `{n} · showing wear` or `{n} · too many`.
   - Unreadable spots (pending + uncorrectable, if either is non-null):
     - Label `Unreadable spots`.
     - Hint: `Parts of the disk the drive couldn't read. Files stored there may already be damaged.`
     - Value: `None` or `{n} · failing`.
   - Rows only when the signal is present:
     - `error_log`: label `Error log`, value `Has errors`, hint `The drive recorded errors while reading or writing. One or two can come from a loose cable; more point to wear.`
     - `self_test_errors`: label `Self-test`, value `Found a problem`, hint `The drive's own surface test found a fault.`
     - `worn_past_limit`: label `Wear limit`, value `Past the maker's limit`, hint `A wear measure the maker sets has passed its failure line.`
     - `worn_in_past`: same label and hint, value `Went past it once`.

   **`steps`:**
   - Failing:
     1. `Plug in another drive with enough free space and add it to Luna.`
     2. `Open this drive, tick Select all, choose Copy, and pick the new drive.`
     3. `When the copy is done, remove this drive from Luna and stop using it.`
   - Watch:
     1. `Keep using it.`
     2. `Make sure its files are backed up: use the Back up button on this drive's card.`
     3. Temperature only: `Give it more air: away from heaters and out of closed cupboards.`
   - Otherwise: `[]`.
4. **`needsYou.js`:**
   - Delete `driveFailedItem` and the `"failed"` branch.
   - Unopenable drive (`isUnopenable`): `{ id:"drive-unopenable:{id}", rank:15, tone:"problem", title:[{name}," can't be opened"], detail:"Its files and free space aren't available. Unplug it and plug it back in.", action:{label:"See what's wrong", href:"/files#drive-{id}"} }`. It pushes the label to `coveredDriveLabels`.
   - Health row from `copy.needsYou` with `id:"drive-health:{id}"` and the same action. It pushes the label to `coveredDriveLabels`.
   - Add `"warning"` to the tone typedef. Add `mounted?: boolean` to the drive typedef.
5. **`NeedsYou.jsx`:** tone `"warning"` uses the `TriangleAlert` icon with `text-warning`. The icon carries the colour; the text doesn't.
6. **`DriveStatusPill({ drive, health })`:**
   - Pill order: `Unplugged`, `Ejected`, then unopenable → warning `Can't open`, then health pill if failing or watch (`copy.pill`), then `Read only` (TermHint as now), then `Ready`.
   - Remove `"failed"` / `"Problem"`.
7. **`DriveHomeCard`:**
   - Admin cards use `useDriveHealth` and pass it to the pill.
   - Unopenable body:
     - Admin: `Luna can't open this drive right now, so its files and free space aren't available.` plus an InfoHint (see W2) and an `Open Files` button to `/files#drive-{id}`.
     - Member: `Luna can't open this drive right now. Ask an Admin to check it.`
   - Remove the `"failed"` branch.

**Render tests:**
- `driveHealth.test.js`: d1 and d2 shapes (failing; watch with 48°C normal, `rows` temperature value `48°C · normal`), not_a_hard_drive gives null, no_report, hot, warm. Assert no `smart` or `SMART` in any string.
- `needsYou.test.js`:
  - d1 gives `" is failing"`, tone problem.
  - d2 gives `" is showing wear"`, tone warning.
  - Unopenable row; it hides `check:drive_*_read_write` for that label.
- `NeedsYou.test.jsx`: the warning tone icon.
- `DriveStatusPill.test.jsx`: `Can't open`, `Failing`, `Showing wear`, no `Ready` when failing.
- `DriveHomeCard.test.jsx`: unopenable as Admin and as Member.
- `DashboardNeedsYou.test.jsx`: the two-drive scenario shows one failing row and one wear row.

**Acceptance:** watch and failing differ in icon, words and action; nothing says "needs attention"; no web code compares numbers to thresholds.

**Scenarios closed:** `dashboard/drive-unhealthy`, `dashboard/drive-unmounted` (dashboard half), `dashboard/everything-wrong` (drive rows).

**Self-check:** `npm run typecheck`, `npm run scan:colors` (in `luna/web`).

## Brief W2 (sonnet, after W1): Files page and drive browser

**Owned files:**
- `luna/web/src/pages/FilesPage.jsx` (+ `.test.jsx`)
- new `luna/web/src/components/files/DriveHealthDetails.jsx` (+ `.test.jsx`)
- `luna/web/src/pages/FilePage.jsx` (+ `.test.jsx`)

**Changes:**
1. **`AdoptedCard`:**
   - Wrap the card in `id="drive-{id}"`. Use `useDriveHealth(drive, showHealth)`. `DriveStatusPill` gets `health`.
   - Remove the separate health Pill and detail paragraph.
   - Surface: one line `copy.summary` when verdict is failing, watch or unknown.
   - Under it, `<DriveHealthDetails>`: `CollapsibleSection` titled `Drive health`, `size="sm" mono pill`. It holds the verdict pill, `ValueDisplay` rows with each label as a `TermHint` (row hint), and for failing or watch an ordered list under a sentence-case heading `What to do` with `copy.steps`.
   - `defaultOpen` when `location.hash === "#drive-{id}"`. Scroll the card into view the same way `#unrecognized-drives` does now.
   - Show it for ok too (collapsed). Omit it when `copy` is null.
2. **Unopenable on Files** (`isUnopenable`):
   - The status message is `Luna can't open this drive right now, so its files and free space aren't available.` with an InfoHint: `Luna knows this drive but couldn't open it. This can happen after it was pulled out without Eject, or when the drive has a problem. Unplug it, wait a few seconds, and plug it back in. If that doesn't help, the drive may be failing.`
   - No storage bar, Browse, Eject, Share or Back up; Remove stays.
   - `driveStatusMessage` drops `"failed"`.
3. **`FilePage` (`/files/:id`):**
   - Unopenable gives an `EmptyState` titled `Luna can't open this drive`. Description: Admin `Unplug it and plug it back in, then try again.`, Member `Ask an Admin to check it.` The action is the same as the missing case.
   - Admin with health failing or watch: `PageNotice` (error or warning) above the explorer, containing `<InlinePill>{label}</InlinePill>` + the `needsYou.title` + `. ` + a `See what's wrong` link to `/files#drive-{id}`. For example: Photos is failing. See what's wrong.
   - Browsing keeps working.

**Render tests:**
- `DriveHealthDetails.test.jsx`: failing shape shows `What to do` and three steps; watch at 48°C shows `48°C · normal`; ok has no steps.
- `FilesPage.test.jsx`:
  - The d1 card has a `Failing` pill, no `Ready`, and no "needs attention".
  - The hash `#drive-d1` opens the health section.
  - Unopenable shows no `Browse files` and no `Storage will show…`.
- `FilePage.test.jsx`: failing notice visible while the file list renders; unopenable EmptyState for Admin and Member.

**Acceptance:**
- `files/failing-drive` shows the warning, what tripped and what to do, while browsing still works.
- The string `Storage will show once Luna can read this drive.` is gone from the unopenable state.

**Scenarios closed:** `files/failing-drive`, `dashboard/drive-unmounted` (Files half).

**Self-check:** `npm run typecheck`, `npm run scan:colors`.

---

## Fake side (harness agent, `luna/web/src/dev`)

**Shape:**
- `fake/handlers/core.js` `healthy()` returns `{available:true, reason:null, verdict:"ok", overall:"passed", model:"WD20EZRZ", serial:"FAKE1", temperature_c:34, temperature_max_c:60, temperature_max_source:"typical", reallocated_sectors:0, pending_sectors:0, uncorrectable_sectors:0, status_bits:0, signals:[]}`.
- Add a `smartHealth(over)` builder in `fake/world.js` that starts from that object.
- Note: the default fake drive is an exFAT stick, which real lunad answers with `reason:"not_a_hard_drive"`. Decide per scenario.

**Drive list:**
- `world.js` `drive()` gets `mounted: true`.
- `GET /api/v1/drives` returns it.
- `/drives/:id/summary` returns `unmounted(id)` whenever `drive.mounted === false`.
- Once 1.4 lands, Members get `mounted` too.

**Scenarios to fix:**
- **`dashboard/drive-unhealthy`:**
  - d1 = `smartHealth({verdict:"failing", overall:"failed", status_bits:8, reallocated_sectors:120, temperature_c:55, signals:[{kind:"self_check_failed",level:"failing",value:null,limit:null},{kind:"reallocated_sectors",level:"failing",value:120,limit:100},{kind:"temperature",level:"note",value:55,limit:60}]})`
  - d2 = `smartHealth({verdict:"watch", reallocated_sectors:4, temperature_c:48, signals:[{kind:"reallocated_sectors",level:"watch",value:4,limit:100}]})`
  - Check: `"Drive 1 is failing, with a red icon, and says why and to copy files off now"`, `"Drive 2 is showing wear, with a yellow icon, and says to keep using it and back it up"`, `"Files: Drive 2 health details say 48°C · normal"`.
- **`files/failing-drive`:** use the d1 shape. Check: `"A notice above the files says the drive is failing, with a link to what's wrong"`, `"Drive health on Files lists what tripped and What to do"`, `"Browsing still works"`.
- **`dashboard/drive-unmounted`:** seed `w.drives[0].mounted = false` (and drop the summary-only seed). Check: `"Card pill says Can't open, not Ready"`, `"Needs you: Drive can't be opened, and the button opens Files at that drive"`, `"Files card has no Browse button and says why"`.
- **`dashboard/drive-failed`:** delete it (lunad has no `"failed"` state). Also remove `state:"failed"` from `everything-wrong`: use `mounted:false` on `drives[2]` and the d1 failing shape.
- Check `fake/handlers/files.js` for `"failed"` and remove it.
- **New:** `dashboard/drive-hot` (temp 61, watch temperature signal), `files/health-unknown` (`available:false, reason:"no_report", verdict:"unknown"`), `files/drive-healthy-details` (ok, temp 52 note: "warm" row).
- **System-check rows:** in `everything-wrong` and `settings/about-versions`, add a `drive_d1_smart` FAILED check with lunad's new strings (`"Drive 1 is failing. Copy your files to another drive now."`). Checks: it shows under system checks but never as a second Needs-you row.
- **Contract (1.8):** add the health, list and summary JSON from Brief L's API tests to the contract fixtures when that lands.

**Self-check:** `npm run typecheck`.

---

## Order

L, then the fake and W1 in parallel (they share the contract above), then W2. Retest the scenarios above after all four land; mark them *Fixed, retest* in the gallery. Don't edit `results.json`.

### Critical files for implementation
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/drives/smart.rs
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/system/system_health.rs
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/drives.rs
- /home/plainskill/Projects/LibreServ/luna/web/src/lib/driveHealth.js
- /home/plainskill/Projects/LibreServ/luna/web/src/lib/needsYou.js
- /home/plainskill/Projects/LibreServ/luna/web/src/pages/FilesPage.jsx
- /home/plainskill/Projects/LibreServ/luna/web/src/dev/scenarios/dashboard.scenarios.js