# State gallery problems

Audit of every scenario in the state gallery (`/__states`), 318 scenarios.

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
| Dashboard | 33 | 33 | 2 | 2 |
| Files | 121 | 121 | 5 | 5 |
| Photos | 41 | 41 | 2 | 2 |
| Recovery | 2 | 2 | 0 | 0 |
| Settings (five sub-areas) | 50 | 50 | 2 | 2 |
| 404 | 3 | 3 | 0 | 0 |
| Setup | 17 | 17 | 0 | 0 |
| Shared | 7 | 7 | 0 | 0 |
| Sharing sheet | 15 | 15 | 1 | 1 |
| Public link | 18 | 18 | 0 | 0 |
| Forms | 4 | 4 | 0 | 0 |
| **Total** | **318** | **318** | **13** | **13** |

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

Now: `To edit this file, save a copy as a .docx file on another device, then upload it
here.`

CSV and other formats that really can convert still read `You can open this file in the
editing view by converting it to a .xlsx file.` with a `Convert & open` button.

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
drive API. The fake registered every other `/s/:token` route but not that one, so the
request fell through to the dev server and the editor rendered the router's answer for
an unknown path — a literal `{}` — as if that were the file's text. The editor was
right; the fake was missing a route. Added it, serving a single-file link's own file and
a folder link's entry from its tree.

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
| `public/file-edit` | The editor body stays empty and says `Connecting…` | **Not a bug.** The editor holds its loading screen until the collab hub answers, and the hub is a real-lunad feature the fake has no endpoint for. The scenario is marked `realLunadOnly` and now says so. |
| `share/links-all-states` | An expired link still offers "Copy link" | **Not a bug for this audit.** The state reads correctly ("expired"), which is what the scenario asks. Offering to copy a dead link is a poor affordance worth a separate change, but it is new behaviour, not a repair. |
| `files/edit-form` | The builder's question input has no label | **Not a bug.** It is the preview of what the person answering will see, and it is `pointer-events-none` — nobody can type into it. Worth naming the check so it skips inert controls. |
| `auth/signed-in-admin` | The greeting printed twice | The second copy is the hidden measurer (`opacity: 0`, `aria-hidden`, zero size) that keeps the header from jumping. |
