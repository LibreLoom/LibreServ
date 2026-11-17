# State gallery problems

Audit of every scenario in the state gallery (`/__states`). The audit covered the
318 scenarios the gallery held at the time; two fake-only scenarios have since been
removed (see §14 and §15), leaving 316 today.

Two passes:

1. **Automatic pass** — every scenario rendered in a real headless browser at its own
   viewport and theme, in both light and dark. Checks: blank page, crash text, page
   wider than the window, low-contrast text (judged from the painted pixels, not from
   CSS), broken-image icons, controls with no name, junk text, all-caps headings,
   bold monospace, clipped content, console errors, and a missing fake response.
2. **Manual pass** — each scenario read against the checks the gallery lists for it.

Status values: **open** (found, not fixed yet) · **fixed** (code changed, needs retest)
· **not a bug** (looked wrong, then verified as working as designed).

---

## Progress

| Area | Scenarios | Audited | Problems found | Fixed |
| --- | ---: | ---: | ---: | ---: |
| Sign-in | 7 | 7 | 0 | 0 |
| Dashboard | 33 | 33 | 3 | 3 |
| Files | 121 | 121 | 4 | 4 |
| Photos | 41 | 41 | 3 | 3 |
| Recovery | 2 | 2 | 0 | 0 |
| Settings (five sub-areas) | 50 | 50 | 2 | 2 |
| 404 | 3 | 3 | 0 | 0 |
| Setup | 17 | 17 | 0 | 0 |
| Shared | 7 | 7 | 1 | 1 |
| Sharing sheet | 15 | 15 | 1 | 1 |
| Public link | 18 | 18 | 1 | 1 |
| Forms | 4 | 4 | 0 | 0 |
| **Total** | **318** | **318** | **15** | **15** |

The 15 counts each area a problem reached, not distinct problems — there are 13
(§1–§13). Two reach more than one area: §3 shows up in Files and in Photos, and §6 in
Settings and in Shared.

The 318 is the inventory that was audited. `public/download-limit` has since been
removed for describing a Luna feature that does not exist, so the gallery now lists
317 — 17 of them Public link.

Counts are the gallery's own `area` values. Settings splits into Luna Connect (20),
Security (7), About (7), Users (6), Appearance (2) and the general settings page (4),
plus Edit user (4) — 50 together. "Sharing sheet" is the gallery's label; the PR calls
it the share sheet.

Both passes are complete and clean: every one of the 318 scenarios has been walked by
hand against the checks the gallery lists, and the automated pass over all 318 reports
**0 findings**. Every problem found is fixed.

## Final confirmation runs

Two consecutive extra-hard passes over all 318 scenarios, both returning **0 findings**:

| Run | Automated audit | Text sweep | Internal links |
| --- | --- | --- | --- |
| 1 | 318 / 318, 0 findings | 318 / 318, 0 junk | — |
| 2 | 318 / 318, 0 findings | 318 / 318, 0 junk | 74 pages, 0 dead |

Beyond the first audit these runs added three checks — an unnamed field, text clipped by
its own box, and a control with no name or icon — and read the file viewer's overlay, which
mounts outside `<main>` and so was invisible to the earlier sweep (32 scenarios). Each new
check was proved able to fail by injecting a violation, then re-run on a clean page.

### Re-run after the review fixes

The two runs above predate the fixes the code review produced, which changed the fake's
request layer (media swapping, downloads, link proofs). The whole gallery was therefore
walked again, twice, from a clean start on the current code, with a second, harder driver
alongside the first. The gallery held 317 scenarios then: `public/download-limit` had
been removed as fake-only (§14).

| Run | Hardened audit | Original audit |
| --- | --- | --- |
| 1 | 317 / 317, 0 findings | 317 / 317, 0 findings |
| 2 | 317 / 317, 0 findings | 317 / 317, 0 findings |

The hardened driver cross-checks a scenario's own Download control (fetching the URL and
asserting real bytes come back), reads raw machine text (`TypeError`, `[object Object]`,
errno codes, braces), bold monospace at any weight, heading order, images pointing at a
raw API URL, and pages stuck on `Loading`. Every added check was proved able to fail by
injecting one violation into a clean page first.

Three checks were written, tried, and retired: a bare `Delete` button, an empty state with
no button, and a `download` whose subject is deliberately missing. All three produced far
more false positives than findings — a row action is named by its row and its confirm
dialog, these empty states already say what will fill them, and a download of an empty
trash is *supposed* to 404 — so they do not belong in a pass that has to stay trustworthy.

These runs found three real defects, all in the fake rather than the product:

- **No `/s/:token/zip` handler.** An album's `Download album` and a folder's `Download`
  hit the router's 501 and did nothing, while lunad zips them. Added, matching lunad's
  three branches: album zip, folder zip, and a file link handing back the file itself.
- **The `view` gate was too strict.** lunad refuses only when `caps & CAP_VIEW == 0`, so a
  `view+upload` link still zips; the first version of the handler refused it.
- **A photo's Download 404'd.** The lightbox downloads through
  `/files/content?download=1`, which reads only the file tree, but seeded photos live in
  the photo index and never enter the tree. The fake now falls back to that index, so a
  photo the person can see can also be saved.

---

## Problems

### 1. A backup whose error names the drive repeats the name — **fixed**

`dashboard/backup-failed`, `dashboard/everything-wrong`, `dashboard/member-with-problems`

The row read:

> Photos backup didn't finish — **Backup drive** Backup drive: Backup drive is full.
> Free up some space on it and try again.

lunad's error already names the drive, and the row also prefixes it, so the name
appeared three times. `backupDetail` only special-cased the exact sentence
`"Backup drive is full."`.

Fixed in `luna/web/src/lib/needsYouBackups.js`: when the error already starts with the
drive's own name, show it on its own.

Now reads: `Photos backup didn't finish — Backup drive is full. Free up some space on
it and try again.`

### 2. A drive-full row said `2.0 GB` where the gallery promised `2 GB` — **fixed (gallery text)**

`dashboard/drive-full`

The row correctly shows `2.0 GB free of 64 GB`; `formatBytes` always keeps one decimal,
and `DashboardNeedsYou.test.jsx` asserts `5.0 GB free of 64 GB`. The gallery's own check
wording was the thing that disagreed with the app. Corrected the check text in
`luna/web/src/dev/scenarios/dashboard.scenarios.js`.

### 3. Photos, videos and PDF frames never loaded in the gallery — **fixed**

`files/view-image`, `files/view-garbled`, `files/edit-diagram`, and every photo in
`gallery/*`

The fake Luna answers `/api/…` by replacing `fetch` and `XMLHttpRequest`. A browser
loads `<img src>`, `<video src>` and `<iframe src>` itself, through neither of those —
so the request went to the real dev server and came back `404`. Every photo in the
gallery showed **"Luna couldn't show this photo. Download it instead."** for a picture
that was perfectly good.

Fixed in `luna/web/src/dev/fake/engine.js`: the fake now also rewrites `src` on image,
media, source and iframe elements (`src` and `setAttribute("src")`) to a blob URL built
from its own answer, so photos, video frames and PDF frames render.

### 4. A PDF offered to "open this file in the editing view" — **fixed**

`files/view-pdf`

The conversion hint rendered the same sentence whatever the format. Under a PDF it
claimed an editing view that does not exist for PDFs (the conversion is deliberately
hint-only), directly below a working preview.

Fixed in `luna/web/src/components/files/FileViewer.jsx`: when we cannot convert in the
browser the hint now says what is actually true.

Before: `You can open this file in the editing view by converting it to a .docx file.
Convert it on another device, then upload the copy here.`

Now: `To edit this file, download it and save a copy as a .docx file in another app.`
Saying "upload it here" pointed a read-only member at a button they may not have, and
Luna has no way to convert a PDF itself, so the hint names Download instead.

A member who can write still gets the in-place offer for formats that really can
convert: `You can open this file in the editing view by converting it to a .xlsx file.`
with a `Convert & open` button.

### 5. A failed token list was shown as "no tokens yet" — **fixed**

`settings/tokens-load-fails`

The list request failed with a 500. `tokens.data` was `undefined`, which the card turned
into an empty array, so it showed **No apps or access tokens are set up yet.** — telling
someone they have no tokens when Luna simply could not check. The check asks for the
error in place; it never appeared.

Fixed in `luna/web/src/components/settings/categories/AccessCategory.jsx`: the card now
says `Couldn't load your access tokens. Try again in a moment.` and the empty state only
shows once the request has actually succeeded.

### 6. A failed user list showed test jargon — **fixed**

`settings/users-load-fails`, `shared/load-fails`, and every scenario with an injected
5xx

The notice printed the raw server text straight through: **`Injected 500`** in place of a
sentence. Two causes, both fixed:

- `luna/web/src/components/settings/categories/UsersCategory.jsx` passed
  `users.error.message` through verbatim. It now says `Couldn't load the people on this
  Luna. Try again in a moment.`
- `luna/web/src/dev/fake/engine.js` invented `Injected <code>` as the body of any fault
  that brought no message of its own. It now answers with a plain sentence, so no
  scenario can show a tester harness jargon.

### 7. A failed map was shown as "no places yet" — **fixed**

`gallery/places-fails`

The scenario's own check says: *"If it says 'No places yet' as if nothing is wrong,
record that as a problem."* It said exactly that. The map request failed, `places.data`
was `undefined`, and the empty state took over — telling someone their photos carry no
location when Luna could not read the map at all.

Fixed in `luna/web/src/components/gallery/PlacesMap.jsx` and `src/pages/GalleryPage.jsx`:
the failed request is now passed through and the tab says `Couldn't load places`.

### 8. A gallery that failed to load offered no way to try again — **fixed**

`gallery/server-error`

The check asks for "an error with a Try again action". The notice said
`Luna couldn't read your photos.` and stopped there, leaving a reload as the only exit.

Fixed in `luna/web/src/pages/GalleryPage.jsx`: the notice carries a `Try again` button
that refetches.

### 9. Opening a file Luna has no viewer for did nothing at all — **fixed**

`files/view-unknown`, `files/edit-whiteboard-collab`

Clicking `mystery.dat` opened nothing: no viewer, no message, no download. The same for
`board.whiteboard`. `FileViewer` already carried the right sentence for this
(*Luna cannot open this kind of file yet. You can download it instead.*) but nothing could
reach it — `canViewerOpen()` refused the name, so the viewer never mounted.

The comment above that function already promised the behaviour: *clicking a .doc should
explain the path forward, not silently do nothing*. It only held for office-adjacent
formats.

Fixed in `luna/web/src/lib/officeConvert.js`: any named file can open, and the viewer
decides what to show. Its test now asserts that a file with no viewer still opens.

### 10. A failed file load left the status bar claiming "Connecting…" — **fixed**

`files/view-load-error`

The error was right, but the bar under it still read `Ln 1, Col 1 · 0 words` and
`Connecting…`. The load had already failed; nothing was connecting and there were no
words to count. Fixed in `luna/web/src/components/files/TextFileEditor.jsx`: under an
error the bar reads `Not loaded` and makes no connection claim.

### 11. The update pill said "ready" after the update failed — **fixed**

`dashboard/update-failed`

An update that never started left the header pill reading `1.5.0 ready`, as if nothing
had gone wrong. The explanation existed only on Settings → About, so on the dashboard
there was no sign of the failure at all — someone would click expecting a clean install.

Fixed in `luna/web/src/components/common/SoftwareUpdatePill.jsx`: with an
`os_update_failed` on the status the pill reads `1.5.0 didn't install` in the error tone,
and it points at Settings to try again.

### 12. Inherited sharing said "shared through" and then nothing — **fixed**

`share/inherited`

The sheet showed `1 person and 1 link shared through ` — the sentence stopped with no
folder named. `inherited_from.name` is optional in lunad's response, and when it was
absent the code joined a list of `undefined` into an empty string.

Fixed in `luna/web/src/components/share/ShareSheet.jsx`: it falls back to the folder's
path. The scenario now reads `1 person and 1 link shared through Photos`.

### 13. A public link had no way to serve the file's own bytes — **fixed**

`public/file-edit`

A guest reads a shared file's contents from the link (`/s/:token/file`), not from the
drive API. The fake had that route, but as a placeholder that answered `{}` to every
request, so the editor rendered a literal `{}` as if that were the file's text. The
editor was right; the route was a stub. Filled it in: a single-file link serves its own file,
a folder link serves an entry from its tree, and an upload-only link (a drop box) is
refused, since that screen promises nobody can see the folder's contents. When the
linked file is a real drive file the route serves that file's bytes — for a folder link
it joins the share's path with the whole relative path, so `Holiday/notes.txt` inside
`Photos` reads `Photos/Holiday/notes.txt`. The built-in folder tree is a list of names
with no files behind them, so those entries get generated text, and browsing into a
folder now lists that folder rather than the root again.

### 14. A public link had a download limit — **removed from the gallery**

`public/download-limit`

lunad has no per-link download count or cap: there is no `max_downloads`,
`download_limit` or `downloads_left` anywhere under `crates/lunad`, and
`access/access_public.rs` never answers 403. The scenario, and the fake rule behind
it, therefore described a state real Luna cannot reach, and made the fake refuse a
download that lunad would have served. The scenario is gone rather than ported: a
gallery entry nobody can reproduce in the product tests nothing and teaches the wrong
thing about the product.

### 15. A public link could be switched off — **removed from the gallery and the fake**

`public/disabled`

Same shape, found later. `AccessLinkRow` (`crates/lunad/src/db.rs:1116`) has no
disabled or revoked column, and the only link routes are create, update and delete
(`crates/lunad/src/api/access.rs:56-60`); removing a link deletes the row, so a link
that once worked answers `404 This link doesn't exist.` The fake nonetheless answered
`403 This link has been turned off.` to any link carrying a `disabled` flag, and a
scenario set that flag — inventing both a screen (*Says the link has been turned off*)
and an answer the daemon can never send. Both are gone: the gate out of `open()` in
`dev/fake/handlers/access.js`, the scenario out of
`dev/scenarios/sharing.scenarios.js`. The reachable states it sat beside are unchanged
and still covered: a token that matches nothing (`public/invalid-token`, 404), an
expired one (`public/expired`, 410 `This link has expired or been removed.`), a
password one (`public/password`, 401), and one whose drive is gone (404 with the
unavailable wording).

---

## Checked and found correct (not bugs)

| Scenario | Looked like | Actually |
| --- | --- | --- |
| `dashboard/system-check-failed` | Two `1 problem` pills on one page | One is inside `header-card-probe`, the invisible measurer (`opacity: 0`). The real one opens a dialog listing Luna's storage, the Clock and Video previews warnings, plus the Settings link. |
| `dashboard/slow`, `settings/all-slow-phone-dark` | Blank page | They simulate a slow network; content arrives at ~8 s. |
| `gallery/broken-thumbs` | Broken-image icons | The `<img>` keeps `opacity: 0` and the calm placeholder shows through, as the check asks. |
| `gallery/normal` and the rest of Photos | `Library` flagged as unreadable | Black on white; the checker was misreading the 10% pill tint behind it. |
| `settings/phrase-resealing` | Card 1867 px wide in a 1280 px window | A progress bar (`animate-md-bar-1`) inside `overflow-hidden rounded-full`. |
| `settings/all-slow-phone-dark` | `Save name` / `Change password` at 1.2:1 | Both are disabled; grey is the point. |
| `public/*`, `forms/password`, `files/moved-link` | Console error about `navigator.vibrate` | Headless Chrome has no user gesture, so the haptics it correctly fires are refused. |
| `files/long-names` | A folder name printed five times | The fixture's name really is that long (`.repeat(5)`) and the row uses `truncate`, so it is one shortened line on screen. |
| `files/view-video` | `This video can't play in the browser` | The fake serves filler bytes, not a real video. The scenario says to judge the frame, title and buttons only. |
| `files/deep-nesting` | Looked like it opened the drive root | The static list I first audited from had truncated the URL expression; the real address carries all 25 levels. |
| `files/edit-diagram` | `404 /drawio/pack.json` | The draw.io pack is optional and not installed in a dev checkout. The viewer says so plainly (*This Luna can't open diagrams … Your file is fine*) and offers Download. |
| `files/listing-error` | `Luna can't find this drive` on a listing 500 | **Not a bug.** The injected fault is on `GET /api/v1/drives/d1/files`, the drive itself, so the app's reading is right; a Try again button is offered as the check asks. |
| `share/view-only-member` | The sheet lists "Person number 2" | **Not a bug.** That is the fixture's display name for its second fake user, not placeholder text from the app. |
| `public/file-edit` | The editor body briefly says `Connecting…` | **Not a bug.** The editor waits up to 10 seconds for the collab hub, then shows the file's own text; the hub is a real-lunad feature the fake has no endpoint for, so it always ends on the fetched text. The scenario is marked `realLunadOnly` and now says so. |
| `share/links-all-states` | An expired link still offers "Copy link" | **Not a bug for this audit.** The state reads correctly ("expired"), which is what the scenario asks. Offering to copy a dead link is a poor affordance worth a separate change, but it is new behaviour, not a repair. |
| `files/edit-form` | The builder's question input has no label | **Not a bug.** It is the preview of what the person answering will see, and it is `pointer-events-none` — nobody can type into it. Worth naming the check so it skips inert controls. |
| `auth/signed-in-admin` | The greeting printed twice | The second copy is the hidden measurer (`opacity: 0`, `aria-hidden`, zero size) that keeps the header from jumping. |

## Fourth pass (gpt-6.1-sol loop continues): a deleted owner left links open

Found while exercising the share routes adversarially in the browser rather than
by reading them.

lunad has **two** deleted-owner gates, and the fake only had the second:

- `load_link` (`access_public.rs:58`) — for every link, before anything else: if
  the link's own subject sits inside a private item whose owner is deleted, the
  link returns `gone()`. It runs whether or not anything private sits *below*
  the link.
- `link_reaches` (`access_public.rs:1023`) — per entry, only where a private
  boundary exists below the link.

The fix for the third review added the second and stopped there. So a share
built **on** a private folder whose owner was deleted still listed, still zipped
and still served its files: 200 on all three. That is the case `load_link`
exists to close, and the fake was answering past it.

Added the missing gate in `open()` (the shared entry for all public routes).
Proven both directions by planting a private folder that really holds the share:

| Owner state | `/list` | `/zip` |
|---|---|---|
| alive | 200 | 200 |
| deleted | 404 | 404 |
| restored | 200 | 200 |

Restoring the owner reopens the link, so the gate closes on the deleted owner
rather than on something incidental.

Also re-checked the six corrections from the third review by calling the routes
directly: root and folder zips return `application/zip` with `PK` magic; a zip
asked for a single file returns that file (`text/plain`, `notes.txt`) instead of
an empty `notes.txt.zip`; and `..`, absolute paths and `../..` escaping the
share are all refused with the named error.

## Third review (gpt-6.1-sol): six findings, verified, fixes held

An independent review at `8397f196` reported six defects. All six were confirmed
against the code and the Rust backend before any fix, and all six are in the
fake — none in product code.

| # | Where | What is wrong |
|---|---|---|
| 1 | `engine.js` `fakeDownloadUrl` | `/s/:token/zip` carries neither a `download` attribute nor `?download=1`, so "Download album" and the folder Download escaped the fake and hit the real proxy. |
| 2 | `access.js` `/zip` | The capability gate matched `"view"` as a substring, so `"full"` (CAP_ALL, which includes CAP_VIEW) was refused. Four scenarios share that way. |
| 3 | `access.js` `linkReaches` | Rust also requires the boundary's owner not be deleted; the fake ignored the owner, so a link inside a deleted owner's private folder stayed open. Single-file `/file` skipped the check entirely. |
| 4 | `access.js` `/zip` | Rust serves the file itself when the target is not a directory; the fake returned zip bytes, or an empty zip named `notes.txt.zip`. |
| 5 | `engine.js` anchor `click` | The patch called the previous wrapper instead of unwrapping `__mockNative`, chaining every earlier dispatcher and world. |
| 6 | `engine.js` media blobs | A blob URL was created per media response and never revoked; the map entry was dropped, the URL leaked. |

All six are now corrected in the working tree and every file bundles cleanly
(esbuild, no output written). They are **not yet verified in a browser**, and
nothing is committed — disk was the limit both times.

Two more sites were found while fixing them. The capability gate was wrong in
three routes, not one: `/list`, `/zip` and `/file` each substring-matched a
single capsule, so `"full"` was refused everywhere. `/file` also skipped
`linkReaches` for single-file links, which is the easiest leak of the three —
a link pointing straight at one private file. Both routes now split
`caps` on `+` and test membership, and `/file` checks reachability like the
others. `serveSharedFile` is the one place that answers with a file's real
bytes, so `/zip` and `/file` cannot drift apart again.

### Capacity blocker

`/` is 184G with **149M free (100% used)**. The gallery evidence this branch
produces is small (2.5M); the pressure is other sessions' archives in the shared
scratch directory (`/home/fluffy-bunny-23/coding/tmp` 2.2G, mostly other
projects; `/tmp` 24G, mostly other agents' baselines). None of it is this
branch's to delete, and clearing caches was ruled out. Fixing 3, 4 and 6 is
small, but verifying them needs a browser sweep that writes screenshots, so the
work is paused rather than risk filling the disk mid-write.

**Consequence for the clean-pass claim:** the two clean passes recorded above
were on `d92e7d90` and `8397f196`. Any fix resets that count, so two consecutive
full clean passes must be re-earned on the final code once capacity allows.

### Second blocker: no browser on this machine

Verifying the six corrections needs a browser, and there is none. The
`chromium-browser` package is a transitional stub that delegates to the Chromium
snap; the installed snap (3594, `latest/stable`) is missing its payload —
`/usr/lib/chromium-browser/chrome` does not exist, the snap's `gpu-2604`
content directory is empty, and `chromium:gpu-2604` is disconnected so
`/snap/bin/chromium` exits without rendering. The previous snap revision (3581)
fails identically, `apt-cache policy chromium` has no candidate, and a
filesystem-wide search finds no `chrome` or `headless_shell` binary.

Reconnecting a snap slot or reinstalling needs root; this account is uid 1002.
So the six fixes are **statically verified only** — `./ci check -r` passes
(format, lint, colour scan, typecheck over `src`, which includes the fake), and
both changed files bundle cleanly with esbuild. No browser has exercised them.

What a browser pass must still prove before the count can restart:

1. `/s/tokfolder/zip?path=Holiday` → 200 zip; `?path=Holiday/notes.txt` → the
   file itself with `Content-Disposition: ...; filename="notes.txt"`, not
   `notes.txt.zip` (finding 4).
2. A link inside a private folder whose owner is in `deletedUsers` → 404, and a
   single-file link pointing straight at a private file → 404 (finding 3).
3. "Download album" and folder Download produce a real browser download through
   the fake, not a request to the real backend (finding 1).
4. A `"full"` link can list, zip and read (finding 2).
5. Photo browsing does not retain blob URLs (finding 6), and a second
   `installFake()` does not chain the old anchor click (finding 5).

## Verification pass: every scenario rendered twice, nothing found

All 317 scenarios were rendered in a real browser twice in a row on the same
code, each frame at its own viewport and theme, and each settled before it was
read. Both sweeps found nothing, so the list above stands as fixed.

The eight scenarios that stay "slow or intentional" (the `*-slow` states, the
all-slowed settings page, the loading state on Shared, and the intentionally
broken thumbnails) were each loaded again and their content read, rather than
being cleared on the grounds that they eventually appeared. That check found
`settings/all-slow-phone-dark` was never actually blank: a probe that dropped
the URL's `#security` fragment had been opening a different panel. With the
fragment kept, the Security page renders in full.

One static check is worth knowing about: `scan:colors` reports the word
"white" inside a check description in `sharing.scenarios.js`. It is prose, not
a colour token, and the line predates this branch.

## Fifth review (gemini-3.8-flash-low on Antigravity): four findings, three fixed

The Codex reviewers used for the earlier rounds are no longer available, so this
round was run on Antigravity's `gemini-3.8-flash-low`. It reported four defects.
All four were read against the Rust daemon before any edit; three were real, one
is recorded below as deferred.

| # | Where | What is wrong | Status |
|---|---|---|---|
| 1 | `access.js` `/s/:token/zip` | A single-file share was served before the drive check, so a link whose drive had been ejected still zipped. | fixed |
| 2 | `access.js` `/s/:token/file` | Said `Not found.` where lunad says `The shared file isn't available right now.` | fixed |
| 3 | `access.js` `open()` | Never checked that the link's own subject still exists (`exists === false` on the resolved entry). | **deferred** |
| 4 | `access.js` `/s/:token/list` | Never consulted whether the drive is usable. | fixed |

The three fixes share one helper, `unavailableShare(world, s, message)`, which
returns the route's own 404 message when `needDrive` refuses and `null`
otherwise. Three guards with three distinct messages stay distinct, and a fourth
route cannot drift, because it has to call the same helper.

Finding 3 is deferred rather than fixed: giving the fake a "the link's subject
was deleted" state means adding a scenario that does not exist, which is a new
feature, not the repair of an existing one. lunad's rule is
`resolve_public_link` (`access_public.rs:48-80`): an entry whose subject is gone
resolves to `gone()`, never to an empty listing. Recorded here so the gap is
visible instead of forgotten.

A real defect found while verifying the above, not from any review: the newer
`GET /s/:token/zip` (a folder share) never called `needDrive` at all. Proven by
ejecting the drive under a live frame: `200 PK` → ejected `404 {` → restored
`200 PK`, and proven able to fail by stashing the fix and watching the ejected
case answer `200 PK` again.

## Two clean sweeps on the final code

After the last share fix (`f69a16845`) both sweeps were started again from zero,
in the same browser tab, against the running dev server, with the checker
reinstalled and then proven able to fail by injecting a `[object Object]` and a
`Luna couldn't do that` into a rendered frame. Each sweep walked all 317
scenarios in registry order, read each frame's own `contentDocument`, and
settled slow states before reading them.

| Pass | Head | Rendered | Unique | Missing | Flagged |
|---|---|---|---|---|---|
| 1 | `f69a16845` | 317 | 317 | 0 | 0 |
| 2 | `f69a16845` | 317 | 317 | 0 | 0 |

An earlier partial pass on this head was discarded rather than continued: the
first flagged frame was a blank dashboard that turned out to be a 2600 ms settle
race, and widening the settle changed the checker, which voids a partial run.

The two adversarial checks that the third review listed as unverified are now
verified in the browser, by counting the calls rather than reading the code:

- **Media blobs are released.** In a live scenario frame, one `<img>` was pointed
  at a fake image and then immediately at a second one. `createObjectURL` ran
  twice and `revokeObjectURL` once, the revoked URL was the superseded one, and
  the element kept the live `blob:` URL. So the reply nobody reads releases its
  URL instead of pinning the body for the life of the document.
- **The anchor patch does not chain.** After two more `installFake()` calls in
  the same frame, the wrapper depth of `HTMLAnchorElement.prototype.click`, of
  the `src` setter and of `setAttribute` was 1 before and 1 after. Each install
  replaces the wrapper over the browser's own method instead of wrapping the
  previous wrapper, so earlier worlds are not kept alive.

## Sixth review (same reviewer, on the fixes): seven findings, six answered

Re-reading the corrected fake produced seven more findings. Each was checked
against lunad before anything changed, and each fix was proven able to fail by
stashing it and watching the old answer return.

| # | Where | What was wrong | Answer |
|---|---|---|---|
| 1 | `/s/:token` | Answered a folder or file share even when its drive was gone. Rust reads the subject through `confined_read`, so it says `The shared files aren't available right now.` | fixed |
| 2 | `engine.js` `swapSrc` | Two elements showing the same picture shared one object URL, so superseding one revoked the URL the other was about to render. Proven: with the old code the second element's URL answered `TypeError: Failed to fetch`. | fixed — the body is fetched once, each element allocates and releases its own URL |
| 3 | `/s/:token/items` | Answered an empty photo page for folder, file and drop box links. Rust's `public_items` answers `gone()` for anything but a viewable album. | fixed |
| 4 | `/s/:token/file` | Called a folder `Not found.`; Rust answers 400 `That's a folder. Use Download to save it as a zip file.` | fixed |
| 5 | `open()` | A link whose subject sits in a deleted owner's private folder answered 404 `Not found.`; `resolve_public_link` answers `gone()`, which the share page reads as "this link has expired or been removed". | fixed |
| 6 | `/s/:token/list` | Reported as returning the wrong thing for a subpath under a single-file link. Rust resolves that subpath through `confined_read`, which fails, so the answer is a 404 either way; only the wording differs. | not reproduced — nothing to fix |
| 7 | `engine.js` | `fetch` and `WebSocket` were rewrapped from the previous wrapper on every `installFake()`, keeping the replaced world alive. | fixed — both keep their native method under `__mockNative`, as `src` and anchor `click` already did |

Fix 2 is worth restating, because it is the one a person would notice: two
thumbnails of the same photo, one of them re-pointed, and the other one goes
blank. The body still comes from one request; only the URL is per element.

## Third and fourth clean sweeps, on the code that answered the sixth review

Both sweeps were re-earned from zero on `f1799b5a9`, after the checker was
reinstalled and again proven able to fail by injecting a `[object Object]` and a
`Luna couldn't do that` into a rendered frame.

| Pass | Head | Rendered | Unique | Missing | Flagged |
|---|---|---|---|---|---|
| 3 | `f1799b5a9` | 317 | 317 | 0 | 0 |
| 4 | `f1799b5a9` | 317 | 317 | 0 | 0 |

The share-gate fixes have their own evidence, taken in a live share frame rather
than from the code: `/items` answers 410, `/file` on a folder answers 400 with
the zip hint, and with the drive ejected `/s/:token`, `/zip` and `/file` answer
404 with the unavailable wording while `/list` answers the folder's own wording.
Restoring the drive brings every route back to 200.

## Seventh review (glm-5.3-flash): thirteen findings against lunad, twelve fixed

This round read `dev/fake/handlers/access.js` and `engine.js` line by line
against `luna/crates/lunad/src/api/access/`. Each finding was reproduced in the
fake or matched to Rust before it was touched; twelve were real and are fixed,
one is recorded below.

| # | Where | What lunad does, and the fake did not | Answer |
|---|---|---|---|
| 1 | `open()` | A token that matches nothing: 404 `This link doesn't exist.` (`access_public.rs:53`). The fake said `Not found.` | fixed |
| 2 | `open()` | Expiry answers `gone()` — 410 `This link has expired or been removed.` (`access_public.rs:32-34`) | fixed |
| 3 | `/s/:token/list` | A link that is not a path subject, or has no view: 410, not 404 (`access_public.rs:396-398`) | fixed |
| 4 | `/s/:token/file` | Same gate, same 410 (`access_stream.rs:19-21`) | fixed |
| 5 | `/s/:token/zip` | Same gate, same 410 (`access_stream.rs:279-281`) | fixed |
| 6 | `/s/:token/stat` | Had no gates at all. Rust: 403 without view (`This link is for dropping files off — it doesn't open what others have added.`), `gone()`, then `confined_read`'s 404 | fixed |
| 7 | uploads | Rust refuses a view-only link with 403 `This link is view-only, so it can't receive files. Ask for a link that allows uploads.` (`access_public.rs:737`), and scopes chunk/complete/cancel to the upload id (`:792-812`) | fixed |
| 8 | `/s/:token` | A link with no view is a drop box: `{kind:"dropbox",caps}`, no name, and a non-empty `?path` is 400 `That folder isn't part of this shared link.` (`access_public.rs:309-323`) | fixed |
| 9 | `/s/:token/list` | A segment that turns out to be a file: 400 `That isn't a folder.` (`access_public.rs:433`) | fixed |
| 10 | `/list`, `/file`, `/zip` | A missing or fenced-off target says which: `confined_read`'s own 404 per route (`access_public.rs:413-423`, `access_stream.rs:26-34`, `:289-297`) and `not_in_share`'s `That item isn't part of this shared link.` (`access_public.rs:224-234`) | fixed |
| 11 | `engine.js` `shown` | Every `installFake()` builds fresh `WeakMap`s, so object URLs painted by the previous installation are never revoked | **recorded, not fixed** |
| 12 | `/s/:token/respond` | Skipped `open()`, so expiry and the password gate did not apply; Rust resolves through the same rails (`forms.rs:173,1447`) | fixed |
| 13 | `/s/:token/items` | Rust names `/s/{token}/media?…&variant=thumb\|content\|download` for every photo (`access_stream.rs:58-70`) and serves `public_media` (`:75`); the fake handed out `data:` URLs and had no `/media` route | fixed |

Finding 11 is recorded rather than fixed: releasing the previous installation's
URLs means keeping a registry of tenths of thousands of entries across
installations, and a gallery frame is a document that goes away with them. The
leak is one URL per painted media element per reinstall, inside a frame that is
removed when the next scenario starts. Fixing it would add exactly the kind of
cross-installation lifetime bookkeeping the rest of this round removed.

Two of the fixes are worth restating. Finding 13 was visible to a person: the
album page's pictures now arrive over `/s/:token/media`, the address the daemon
serves, and the fake's own bytes are decoded out of the `data:` URL first. Proved
in a live frame — 80 images, all 80 pointing at `blob:` URLs minted from the
route, 70 loaded above the fold. And finding 8's drop box now carries no name, so
a share that promises nobody can see its contents cannot leak the folder's name
in the page's own `/s/:token` answer.

## Two clean sweeps on the code that answered the seventh review

Sweeping `e178f5f47` turned up one flag that was not a defect, and it changed how
the checker measures. A sweep of all 316 came back clean, and the sweep after it
read `forms/password` as a blank page. Re-timed in two fresh frames with the same
URL, that page had 0 characters at 300 ms, 24 at 900 ms and 143 from 2600 ms, and
loaded standalone in under a second and a half: the frame had been read before the
app had painted, not after it had failed. Two things followed.

- A blank reading is now re-probed 3000 ms later before it is believed. Nothing
  else about the checker changed.
- Each scenario's result is written to this browser's `localStorage` as it is
  taken, so a tab that goes away mid-sweep costs one scenario instead of the
  sweep. Three tabs were lost to this environment while these passes were being
eared; the ones recorded here were finished without losing one.

Because the checker changed, both sweeps were started again from zero. Each
walked all 316 scenarios in registry order on `e178f5f47` with checker `v9`, whose
self-test was re-run on install and still flagged a white-on-white paragraph, an
`[object Object]`, an all-caps line and a `Luna couldn't do that`, and still
passed a plain paragraph. Both came back with nothing flagged and nothing
re-probed.

| Pass | Head | Checker | Rendered | Unique | Missing | Flagged | Re-probed |
|---|---|---|---|---|---|---|---|
| A | `e178f5f47` | `v9` | 316 | 316 | 0 | 0 | 0 |
| B | `e178f5f47` | `v9` | 316 | 316 | 0 | 0 | 0 |

The public-share half was swept separately in between, all sixteen `public/`
scenarios, which is where the seventh review's fixes live; it came back empty too.

## Eighth review: the public-link routes, answered exactly

The seventh review's fixes were checked by re-reading the same eight public
routes in narrow rounds — a handful of addresses at a time, because a wider
prompt ran out of steps before it said anything. Two rounds came back empty and
three more found real gaps, all of them in the fake's answer rather than in a
screen:

| Round | Asked about | Findings | What they were |
|---|---|---|---|
| 2c | root, `/items`, `/list`, `/file`, `/zip` | 10 | 9 confirmed, 1 the reviewer missed (see below) |
| 2d | `/stat`, `/media`, uploads, `/respond` | 15 | all 15 confirmed |
| 2c-b | `/file` wording on a folder link | 1 | confirmed |
| 2c-c | root, `/items`, `/zip`, `/media` after the first fixes | 5 | all 5 confirmed |
| 2c-d | root `?path`, `/items` paging, album zip name | 5 | all 5 confirmed |
| 2c-e | root `?path`/`?meta`/`?download`, `/items`, `/list`, `/file`, `/zip` | 6 | all 6 confirmed |
| 2d-d | `/stat`, `/media`, uploads, `/respond`, the password lock | 13 | 12 confirmed, 1 recorded below |

Every finding was checked against `luna/crates/lunad/src` before anything
changed, and each fix was then proved in a live frame — a wrong-password count,
a chunk without a range, a session finished twice, a photo asked for on the wrong
drive, a single-file link asked for its own root. Two rounds ended without a
`VERDICT:` line at all (a silent provider, and a thread that vanished mid-report);
neither counted as a review, and the scope they had covered was re-asked rather
than assumed.

Two things are worth keeping. A review is a hypothesis, not a verdict on the
code: 2c's tenth finding — `/zip` on a file link answering the folder wording
where lunad raises `not_in_share` — was one the reviewer never listed, found
while checking its nine. And a wide review prompt is a liability: the rounds that
answered were the ones that asked about five routes and required the verdict on
the first line, so a step budget could not swallow it.

The upload contract was the largest single correction, and it is now the
daemon's: a full-access link receives files (CAP_ALL includes CAP_UPLOAD), a
1 TB ceiling and `safe_name` refuse the same names, an album takes only pictures
and video, a view-blind link refuses a nested path, a chunk must carry a range
whose length matches its body, completing before every byte is there is refused,
a finished or cancelled session is *unknown* (404) rather than *not active*
(409), and the answer is a `FileEntry` with no stat-only fields. The password
lock became the daemon's time window — 60 seconds, doubling, cleared by the right
password — instead of a permanent count, and a single-file link's root serves its
bytes unless the caller asked for `?meta=1` or JSON. Every view gate now reads
`full`, `edit`, `write` and `read` as the capabilities they stand for, which they
did not before: a `full` link was being treated as if it could see nothing.

One finding is recorded and not fixed, because the fake has no form file to lose:
`respond_lookup` in lunad resolves the `.lunaform` file and answers "This form
isn't available right now." when it is gone, while the fake keeps the form and
its answers on the link record itself. Simulating that would mean inventing a
second store for the same data, so the scenario that exercises a deleted form
(`forms/respond-link`) covers the answers path instead.
