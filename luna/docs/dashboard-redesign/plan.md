# Dashboard redesign — plan (2026-10-18)

Status: approved, not started. Rebuilds `luna/web/src/pages/DashboardPage.jsx`.

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
│ ⚠ Backup drive has a problem                     [Open Drives]     │
│ ⚠ "Photos" backup didn't finish                  [Open]            │
│ ⓘ New drive plugged in                           [Add drive]       │
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
| A drive has a problem | `drive.state === "failed"` | Open Drives | "Needs a look" card |
| Failed system health checks | `useSystemHealthCheck`, `status === "failed"` | per check | header pill |
| Drive health warning or failure | `/api/v1/drives/{id}/health` → `describeDriveHealth` (`warning` / `error`) | Open Drives | not on the dashboard |
| A backup failed or its source is missing | `needsALook` rows from `lib/backupRows.js` | Open (ProtectSheet) | inside BackupsCard |
| Device token problem | `connect.device_token_error` | Change the device token (`/settings#about`) | inside ConnectionCard |
| No internet route (only when true) | `network.has_default_route === false` | — / Settings | ConnectionCard headline |
| New drive plugged in | `/api/v1/drives/detected` | Add drive (picker → InspectModal) | card under drives |
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
Greeting, `TipPill`, the drive picker modal, `InspectModal` and the adopt flow (the Needs you row opens the picker).

## 8. Tests and checks
- `DashboardPage.test.jsx`: delete the uptime, network-status, remote-access and fit-or-stack tests. Rewrite the drive-card test (no counts) and the recents test (row is the link, cap of 6).
- New render tests: each Needs you item; zone absent when nothing applies; Admin vs Member (Member sees only own backup failures, no pills); Member drive card with shortcuts + See all shared items; storage omitted when not returned; warnings-only `SystemHealthPill`.
- Move the problem/reminder tests from `BackupsCard.test.jsx` to the new zone.
- Copy follows the plain-language rules in the root `AGENTS.md`. Shared primitives already fire haptics.
- `npm run scan:colors`, then `./ci run -profile luna`.
