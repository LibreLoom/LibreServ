# AGENTS.md - LibreServ monorepo guide

This repo holds multiple products. Each area has its own AGENTS.md — read it before working there.

## Layout

```
sol/      LibreServ Sol, the home server: server/backend (Go 1.26, chi), server/frontend
          (React 19, Vite, Tailwind 4), connect/ (cloud SaaS), iso/, install.sh, Dockerfile
luna/     LibreServ Luna, the file box: crates/lunad (Rust daemon), crates/luna-core, web/,
          desktop/ (GTK 4), mobile/ (Android), connect/ (cloud companion), os/
shared/ui @libreloom/ui — shared React components for both product webs
infra/    ci-source/ (CI runner), agents/ (repo bots), docs/ (release process)
ci        CI launcher: ./ci (interactive), ./ci run -profile full | libreserv | luna
release.sh  release pipeline (both products)
keys/     release minisign PUBLIC keys
.claude/  Claude Code cloud setup script copy + SessionStart hook
```

**Public paths that must not move:** `sol/install.sh` (fetched by raw URL) and `keys/` (Sol and lunad embed their minisign keys at build time; the Connect deploy script and the Flatpak repo server read them from the checkout). Release process: `infra/docs/RELEASE-PLAN.md`.

## Plain language (non-negotiable)

Our users are **not technical**, and **nobody should ever need a terminal**: everything happens in the UI. Write for a smart person who doesn't work in our field. This covers everything a user reads — labels, buttons, hints, onboarding, settings, empty states, notices, errors. When these pull against each other, the earlier one wins:

1. **Be true.** Copy must match what the product actually does. Don't overstate, soften, or guess. If you're not sure, find out, or say less.
2. **Be specific.** The ordinary word (`router`, `backup`, `Admin`, `Read`), the real place (`Settings → Email`), the actual file, drive, or value.
3. **Give what the person needs at that spot:** what this is, why it matters, where a value comes from, what happens next, or what they can do — whichever the moment calls for, not all of it everywhere.
   - Not `"SMTP connection refused"` but `"Could not connect to your email provider. Check the server address and port in Settings → Email."`
   - Not a bare "API Token" field but `"Your API token is on cloudflare.com → Profile → API Tokens → Create Token."`
4. **Keep it short.** One sentence is easy; three is too much. Default to one short sentence per element.
5. **Structure and leveled disclosure, not paragraphs.** Use the shapes the UI has — label and value, list, heading, status pill, table — and lead with the words that matter.
   - **Surface:** the name, its state, at most one sentence.
   - **One step in:** the rest — InfoHint/TermHint, a row or section that expands, a details view.
   - Each level must make sense alone. Never hide what someone needs to decide or act safely (like what a delete removes).
6. **Be easy to read.** Everyday words. No commands or developer steps. Not baby talk: never swap a real word for a euphemism or metaphor.

**Define terms; don't avoid them** — in the sentence (`RJ45 (ethernet) cable`), or with `InfoHint` (ⓘ aside) / `TermHint` (dotted underline) from `shared/ui/components/ui/Tooltip.jsx`. Usually needs a gloss: SMTP, SSH, DNS, TLS/HTTPS, port, subdomain, API, webhook, OIDC, DDNS, RJ45, ethernet.

Not covered: code comments, logs, internal docs. Dashboard greetings (pigeons, snacks) are personality — leave them; roles, permissions, and setup steps are not the place for it.

**Wall of shame** — shipped once, never again:

| Shame | Use instead |
|---|---|
| Takes care of Luna / person who takes care of this Luna | `Admin` + InfoHint |
| Household (role badge) | `Member` |
| Can look / Can add and change | `Read` / `Write` + TermHint |
| internet box | `router or modem` |
| LAN socket — the same kind of socket your home internet uses | `RJ45 (ethernet) cable` |
| Spare copy in the cloud | `Cloud backup` |
| Apps and helper tools | `Apps and access tokens` |
| Luna is asking this drive how it feels | `Checking this drive's health` |
| this box (for Luna) | `Luna` / `this Luna` |
| Couldn't do that | Name the action that failed |

## Frontend (all web UIs)

- `.jsx`, not `.tsx` (`npm run typecheck` still checks JSDoc). Vitest + Testing Library. Imports: React → third-party → local, with `.jsx` extensions.
- Shared components live in `shared/ui` (`@libreloom/ui`) — edit them there, never fork into an app. App-local copies (settings categories, pages) stay in sync until they migrate.
- No manual cachebusters (`favicon.svg?v=6`): Vite hashes built assets. No `.gz` pre-compression either — Vite emits it.
- **Keyboard shortcuts:** register with `useShortcut(keys, handler, { label, group })` from `shared/ui/context/ShortcutsContext.jsx`, never a raw `keydown` listener. It skips typing fields and open dialogs, and the `?` sheet lists whatever is registered, so `label` is user-facing copy (plain words). A page's own key beats a global one with `priority: 1`. Alt combos match the physical key. Nav is `Alt+Shift+<navbar position>`.
- **Settings search** indexes itself from `SettingsCard` / `SettingsRow` (`shared/ui/lib/settingsSearch.js`), so build settings from those two and nothing else needs updating. A card needs a `title`; a row needs a `label`.
- **Form fields** (`input`, `textarea`, `select`): never `focus:ring-*` — mouse focus must not draw a ring. Use `focus:border-accent`; keyboard focus uses the global `:focus-visible` outline (or `focus-visible:border-*` with `no-focus-outline`). Buttons, links, and toggles may keep `focus-visible:ring-*`.
- **Toasts** (`shared/ui` `ToastContext`) announce something that **just finished**:
  - Do: every user-fired mutation's result (`success`); failures with no inline home (menu, drag-drop, shortcut, closed dialog) — `message` = what failed, `description` = what to try; background/poll/job failures.
  - Don't: errors an open modal or form owns, sync validation (shake + inline), rapid toggles, persistent state (use `PageNotice` or card state), progress.
  - One toast per outcome; never re-fire inside a retry or poll. `addToast` fires its own haptic.

### Design / Theme — "Simplex Mono" (https://gt.plainskill.net/LibreLoom/design)

Agents repeatedly break contrast and flatten the design. Default hard to these rules and question any deviation out loud. Run `npm run scan:colors` after UI edits; it also rejects bare `bg-primary` / `bg-secondary`. Every vitest test fails if it leaves text the same color as the surface behind it (`shared/ui/test/contrast.js`) — fix the markup, don't opt out.

- **Tokens only, never hex.** `surface-primary` (page: primary background + secondary text), `surface-secondary` (card: the inverse), `text-primary` / `text-secondary` for text alone, `bg-accent` (#767676), `bg-success/error/warning` tints. Vars swap on `.dark`, so each surface is the light one in one mode.
- **Accent is reserved** for caution/danger (`Button variant="accent"`, `CardButton variant="danger"`) and true accent pieces: borders, rings, dividers, focus outlines, link underlines, carets. Never `text-accent` for muted text, never `bg-accent` fills or tints. Selected states invert to the surface token — check the real backdrop.
- **Backgrounds come with their text color.** Change a background only with `surface-primary` / `surface-secondary`, never a bare `bg-*` token or a separate bg/text variable pair. Before setting a text color, find the nearest ancestor surface — often a panel in another component, not the card you see — and name it. Status colors (`text-warning/success/error`) are for icons, not text: yellow and green text is unreadable on the light surface.
- **Full opacity by default.** No `text-primary/70` for "muted" text; pick a different token. Opacity is for status tints (and the global placeholder fade) only: `/20` fill + `/30` border (`bg-error/20 border-error/30`).
- **Layered, pill-based, animated.** Surfaces inside surfaces, each setting its own contrast. `rounded-pill` for buttons, chips, and badges; `rounded-large-element` (24px) for cards and rows. Intentional motion on state changes. One outline per element: never a `border` plus a `ring` at once (`border` = persistent state, `ring` = transient; keep `border-transparent` for size stability).
- **Mono identity, never bold.** Monospace (FreeMono) for headings and code, Noto Sans for body. Never `font-mono` with `font-medium/semibold/bold` or `<strong>`/`<b>`; emphasize with size or color. Tabular data renders in sans (only its header row mono).
- **Names and literals in copy wear a pill.** A thing's name quoted inside a sentence or shown as a value — drive name, file name, path, URL, IP, port, domain, username, token, option name — uses `InlinePill` (`shared/ui/components/common/InlinePill.jsx`), never a bare `font-mono` span: mono alone reads as an accidental font change, not a deliberate chip. Mono stays on whole runs (headings, titles, status lines, meta counters, code, inputs) and conditional component props; `scan:colors` (scan-surfaces) rejects naked `font-mono` — justify a real exception with `// surface-scan: ignore-line -- reason` (or `ignore-next-line` / `ignore-file`).
- **Placeholders are always italic and slightly faded** (the one allowed use of opacity on text besides status tints). A global `::placeholder` rule in each app's `index.css` sets the field's own text color at `opacity: 0.7` plus italic, so typed text and hints never look alike. Never add `placeholder:text-*`, `placeholder:italic`, or opacity per field.
- **Sentence case, never all caps.** Headings, card and modal titles, labels, and table headers capitalize only the first word and proper nouns (`System check`, `Color presets`, `Luna Connect`). No `uppercase` class and no wide tracking to fake it; `scan:colors` rejects `uppercase`. Acronyms keep their caps (`DNS`, `MFA`).

### Haptics (non-negotiable)

Every interaction is felt, through `haptic()` in `shared/ui/utils/haptics.js` (it honors the user's toggle). **Components own their haptics:** the `shared/ui` primitives (Button, CardButton, Toggle, Dropdown, CollapsibleSection, InfoHint/TermHint, ModalCard, ConfirmModal, `addToast`, `shakeElement()`, …) already fire them, so pages add none. Call `haptic()` directly only for custom surfaces (gestures, drag/drop, FAB snap, scrubbers), and put it inside any new reusable control.

| Preset | For |
|---|---|
| `selection` | tabs, segmented controls, nav links, table rows, checkboxes, dropdown items, thumbnails |
| `light` | small toggles, tooltip pins, search open/clear, accordions, pill actions |
| `medium` | card buttons, opening files/folders, lightbox, rescans |
| `heavy` | file drops |
| `rigid` | drag start, snap, edge resistance, long-press threshold |
| `success` / `warning` / `error` | outcomes / destructive prompts opening / validation and failures |

Sync with the animation. Never buzz on hover, scroll, or typing. Never double-buzz for one action.

## Git

- **`origin` (GitHub) and `forgejo` (gt.plainskill.net) are ONE repository, kept identical by a mirror.** Fetch, merge, and diff against the branch's upstream (usually `origin`) only; never treat them as divergent or remark that they match.
- **Push once** to the upstream remote; the mirror copies it. Never dual-push commits or branches — it races the mirror. If a forge looks behind, wait.
- **Tags don't sync.** Push release tags to the forge the consumer fetches (Luna Connect at `/opt/LibreServ` pulls Forgejo), or deploy with `deploy.sh --head` / an explicit SHA.
- Conventional commits (`feat(scope): …`, `fix(scope): …`); branches `feat/`, `fix/`, `docs/`, `chore/`.

## Claude Code cloud environment

- The environment's **Setup script** box holds a copy of `.claude/cloud-setup.sh` — keep them in sync. It installs toolchains only (apt packages, Go 1.26, Rust 1.96, Android SDK, `fj`) to stay under the ~5 min cache limit; needs network access **Full**.
- `.claude/session-start.sh` (cloud only) starts Podman, seeds mock drives and mock Connect (`:18765`), then builds in the background. Wait until `/tmp/libreserv-session-setup.state` reads `done` before building or testing (log: `/tmp/libreserv-session-setup.log`).
- Forgejo auth is an environment **API credential** for `gt.plainskill.net` that the agent proxy attaches; the token is never in the session.

## Notes for agents

- **Go 1.26 is real** and every Go 1.26 image exists. Don't question it.
- **Early development, no existing users.** No backwards compatibility or migrations unless asked; tear obsolete concepts down completely.
