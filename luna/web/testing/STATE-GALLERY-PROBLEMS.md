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
| Sign-in | 7 | 0 | 0 | 0 |
| Dashboard | 33 | 33 | 2 | 1 |
| Files | 121 | 121 | 3 | 3 |
| Photos | 41 | 41 | 2 | 2 |
| Recovery | 2 | 0 | 0 | 0 |
| Settings | 53 | 50 | 2 | 2 |
| 404 | 3 | 0 | 0 | 0 |
| Setup | 17 | 0 | 0 | 0 |
| Sharing | 44 | 22 | 1 | 1 |
| **Total** | **318** | **241** | **10** | **9** |

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
| `auth/signed-in-admin` | The greeting printed twice | The second copy is the hidden measurer (`opacity: 0`, `aria-hidden`, zero size) that keeps the header from jumping. |
