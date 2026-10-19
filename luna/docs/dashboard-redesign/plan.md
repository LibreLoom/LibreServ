# Dashboard redesign — plan (2026-10-18)

Status: implemented (2026-10-18). Rebuilds `luna/web/src/pages/DashboardPage.jsx`.

## 1. Principle
The dashboard holds only what the person wants to know **now**: what needs them, what they were just working on, and the way back into their files. Anything that is fine or rarely changes stays off the page.

- **"Needs you" rule:** a row names the problem and gives one button that fixes it, or opens the place where it gets fixed. If the viewer can't act on it, it is not a "Needs you" row. It shows as a status on the relevant card instead.
- When nothing needs the viewer, the zone does not render. There is no "All good" card.

## 2. Layout, top to bottom
1. **Header:** greeting (kept; personality) + `TipPill`. Admin only: `SoftwareUpdatePill` and `SystemHealthPill`, which now shows **warnings only** (see §5).
2. **Needs you:** full width, ordered by urgency, compact rows with one action each.
3. **Recents** | **Drives** (Admin) / **Your folders** (Member): side by side on desktop. On phones: Needs you → Recents → drives.

## 3. Admin view

```
Greeting                                   [tip]          [0.4.2 ready]
┌ Needs you ─────────────────────────────────────────────────────────┐
│ ⚠ Backup drive has a problem                     [Open Files]     │
│ ⚠ "Photos" backup didn't finish                  [Open]            │
│ ⓘ Check your recovery phrase                     [Check now]       │
└────────────────────────────────────────────────────────────────────┘
Recents                        │ Drives
  Taxes 2026.pdf    2 h ago    │ ┌ Home drive        Ready ┐
  Photos / Summer   yesterday  │ │ 1.2 TB free             │
  …up to 6                     │ │ (Photos) (Documents) …  │
                               │ │ [Browse files]          │
                               │ └─────────────────────────┘
```

**Needs you items (Admin), most urgent first:**

| Item | Source | Action | Today |
|---|---|---|---|
| A drive has a problem | `drive.state === "failed"` | Open Files | "Needs a look" card |
| Failed system health checks | `useSystemHealthCheck`, `status === "failed"` | per check | header pill |
| Drive health warning or failure | `/api/v1/drives/{id}/health` → `describeDriveHealth` (`warning` / `error`) | Open Files | not on the dashboard |
| A backup failed or its source is missing | `needsALook` rows from `lib/backupRows.js` | Open (ProtectSheet) | inside BackupsCard |
| Device token problem | `connect.device_token_error` | Change the device token (`/settings#about`) | inside ConnectionCard |
| No internet route (only when true) | `network.has_default_route === false` | — / Settings | ConnectionCard headline |
| New drive detected | `/api/v1/drives/detected` | Add drive (opens the Files page at its Unrecognized drives section) | "New drive detected" card after the drive cards, not a Needs you row |
| Drive almost full | drive summary `free_bytes` / `total_bytes` (already fetched) | Browse files | not flagged |
| Check your recovery phrase | `phrase.check_due` + a cloud backup exists | Check now (RecoveryPhraseCheck) | inside BackupsCard |
| No drives yet (first run) | no adopted drives | "Plug a USB drive into Luna to get started." | separate EmptyState |

**Drive cards:** name, `DriveStatusPill`, free space, folder shortcuts as pills, `Browse files`. Unplugged / ejected / problem states keep their current copy. The "N folders · N files at the root" line is removed.

## 4. Member view

```
Greeting                                                    [tip]
┌ Needs you ─ (only if one of their own backups failed) ─────────────┐
Recents                        │ Your folders
  Recipes.docx      1 h ago    │ ┌ Home drive        Ready ┐
                               │ │ (Family photos) (Sam)   │
                               │ │ [Open Family photos]    │
                               │ │ See all shared items    │
                               │ └─────────────────────────┘
                               │ Albums shared with you
                               │   Summer 2026     [Open]
```

- **Needs you** is almost always empty. The only Member item is one of their own backups failing (`/api/v1/backups` returns only the caller's own for Members). Failed or unplugged drives are not their job. They show on the drive card as "Ask an Admin to check it" (current copy).
- **"Shared with you" folds into the drive cards.** `drive_summary` already returns a Member's shared and private folders as `shortcuts` (`grant_shortcuts`), and the card already deep-links to the shallowest grant. The separate list duplicated it. The card gains a **See all shared items** link (`/shared`). The column is titled "Your folders" for Members.
- **Storage** only shows when the API returns it (`can_see_space`: View on the drive root). Otherwise the line is left out, never blank. Low space is never a Member item.
- **Albums shared with you** stays as is (max 8 + See all albums).
- **Only albums shared:** Recents + albums card.
- **Nothing shared yet:** keep "Nothing shared with you yet. Ask an Admin to share a folder, drive, or album with you."
- No header pills (same as today).

## 5. Decisions (settled)
- **System health:** failed checks move into Needs you and are removed from the pill. `SystemHealthPill` shows warnings only (always the warning style) and hides when there are none.
- **Software update** stays a header pill.
- **Healthy backups:** one quiet line, e.g. "Backed up 2 hours ago" (uses `backupHeadline` / `lastTestedLine`), with **See all backups** opening `AllBackupsModal`. Hidden when there are no backups.
- **Storage** always shown on drive cards when the API returns it.
- **Recents:** capped at 6. Each row is one link (name, location, time ago), no separate Open button. Hidden when empty.

## 6. Removed
- `UptimeCard`, `formatUptime`, and the dashboard's `/api/v1/health` query (the dashboard is its only user).
- `ConnectionCard`, `RemoteAccessLink` and its fit-or-stack measuring. Remote access stays in Settings → External services. Its action items move to Needs you (§3).
- `BackupsCard` as a card: its problems and phrase reminder move to Needs you, the healthy summary becomes the quiet line. `AllBackupsModal`, `ProtectSheet` and `RecoveryPhraseCheck` are reused.
- Root counts on drive cards (`countLine`).
- The Member "Shared with you" card (§4).

## 7. Unchanged
Greeting and `TipPill`. The drive picker modal and the Dashboard's `InspectModal` flow are gone: adding a drive happens on the Files page.

## 8. Tests and checks
- `DashboardPage.test.jsx`: delete the uptime, network-status, remote-access and fit-or-stack tests. Rewrite the drive-card test (no counts) and the recents test (row is the link, cap of 6).
- New render tests: each Needs you item; zone absent when nothing applies; Admin vs Member (Member sees only own backup failures, no pills); Member drive card with shortcuts + See all shared items; storage omitted when not returned; warnings-only `SystemHealthPill`.
- Move the problem/reminder tests from `BackupsCard.test.jsx` to the new zone.
- Copy follows the plain-language rules in the root `AGENTS.md`. Shared primitives already fire haptics.
- `npm run scan:colors`, then `./ci run -profile luna`.

## Decisions recorded 2026-10-18 (implementation)

- D1 Item shape: `{ id, rank, tone, title, detail?, action? }`; title segments are strings or `{ name }` (rendered as InlinePill); action has `href` or `intent`, or is absent (first-run row only).
- D2 Ids, stable and unique: `drive-failed:<driveId>`, `check:<checkName>`, `drive-health:<driveId>`, `backup:<kind>:<id>`, `device-token`, `no-route`, `drive-full:<driveId>`, `phrase-check`, `no-drives`.
- D3 Rank, lower is more urgent: drive failed 10, failed check 20, drive health 30, backup 40, device token 50, no route 60, new drive 70, almost full 80, phrase check 90, no drives 100; ties by id. Tone is `problem` for ranks 10-60 and 80, `info` otherwise.
- D4 `buildNeedsYouItems` takes one named object and returns items sorted by rank; pure, with no React, fetching or `Date.now`.
- D5 Admins get every applicable row; Members get only their own failing backups and the phrase reminder. A private backup not created by the viewer never shows.
- D6 Failed checks only (`status === "failed"`), one row each, action "Open system checks" to `/settings#about`. Excludes: `backups` category, `drive_*_smart`, `network` without a no-route row, `connect`/`remote_access` without a device-token row, `drive_*_read_write` for a drive with a drive-failed or drive-health row.
- D7 Drive health row for `warning`/`error` pills only; drive failed row when `state === "failed"`. Both action "Open Files" to `/files`.
- D8 Backup row (Admin: any non-foreign-private; Member: own) when `needsALook`: failing, stale, or cloud source missing. Detail is `last_error`, then `check_problem`, then a short sentence. Intent `open-backup`, payload is the row.
- D9 Device token row (`connect.device_token_error`, to `/settings#about`); no-route row (Admin, `has_default_route === false` strictly); no new-drive row: detected devices get the "New drive detected" card after the drive cards instead (Admin only), and "No drives yet" is hidden while one is waiting.
- D10 Almost full: Admin only, state `as_is` or `readonly`, mounted, total > 0, free under 10% of total. Detail "`<free>` free of `<total>`" via the shared byte formatter; action "Browse files" to `/files/<id>`.
- D11 Phrase reminder for anyone when `check_due` is true and the viewer can see a cloud backup row; intent `check-phrase`, label "Check now".
- D12 No drives yet: Admin only, once loaded, zero drives; no action; the old EmptyState is removed.
- D13 NeedsYou.jsx shows 5 rows with "Show N more" / "Show fewer"; null when empty; region named "Needs you" with a mono heading; status color on the icon only; `surface="primary"` buttons; `Link` for href, `onAction(item)` for intents.
- D14 BackupsLine hidden when there are no rows; shows `backupHeadline` and `lastTestedLine` plus "See all backups" (AllBackupsModal); sits below the Needs you zone, above Recents/Drives.
- D15 DriveHomeCard: no counts line; storage only when usable space is returned, otherwise omitted; shortcuts as pills; Members get "See all shared items" when they have grants; heading "Drives" (Admin) or "Your folders" (Member).
- D16 RecentsCard: server items capped at 6, each row a single Link (name, location, time ago); null when empty; heading "Recents".
- D17 SystemHealthPill: warnings only, always the warning style, "N warning(s)"; null while loading, on error, or with none; dropdown kept.
- D18 Removed: UptimeCard, formatUptime, ConnectionCard, RemoteAccessLink with its measuring code, connection helpers, countLine, the dashboard health query and `getHealth` if nothing else uses them, BackupsCard.jsx and its test. Kept: `useConnectActive`, `rootTerm`.
- D19 Query keys reused so nothing is fetched twice: `["drive-summary", id]`, `["drive-health", id]`, `["connect-status"]`, `["network-status"]`, `["drives-detected"]`, `["system-health-check"]`, and the BackupsCard keys; Admin-only queries stay disabled for Members.
- D20 Haptics: no new calls; shared primitives already fire them.

### Deviations from the plan text

- Members keep the recovery-phrase reminder (their own key).
- Needs you shows 5 rows then a Show more toggle.
- Backup-category and drive smart checks are not repeated as failed-check rows.
- Almost full means under 10% free.
