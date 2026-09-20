# AGENTS.md - LibreServ monorepo guide

This repo holds multiple products. Product-specific rules live in each area's
own AGENTS.md — read it before working there.

## Layout

```
LibreServ/
├── sol/                  # LibreServ Sol — the home server product
│   ├── server/backend/   # Go 1.26 backend (chi/v5)
│   ├── server/frontend/  # React 19 + Vite 7 + Tailwind 4
│   ├── connect/          # LibreServ Connect cloud SaaS (independent Go module)
│   ├── iso/              # kiosk image bits
│   ├── install.sh        # public installer — fetched via raw URL, path is load-bearing
│   ├── install-lib/      # installer helpers
│   ├── Dockerfile        # all-in-one image (build context = repo root)
│   └── AGENTS.md         # sol-specific rules
│
├── luna/                 # LibreServ Luna — the file box product
│   ├── crates/lunad      # Rust daemon
│   ├── crates/luna-core  # shared Rust lib
│   ├── web/              # Luna web UI (React/Vite)
│   ├── desktop/          # GTK 4 + libadwaita companion app
│   ├── mobile/           # Android companion app (F-Droid + signed APK)
│   ├── connect/          # Luna Connect cloud companion (independent Go module)
│   ├── os/               # Debian live OS, A/B updates, factory ISO
│   └── AGENTS.md         # luna-specific rules
│
├── infra/                # shared tooling
│   ├── ci-source/        # custom CI runner source (./ci launcher auto-rebuilds)
│   ├── agents/           # repo automation bots (atlas/docs/lock); common/ holds
│   │                     # the shared dsh-home, loops, and plugins
│   ├── docs/             # release process docs
│   └── AGENTS.md
│
├── ci                    # CI launcher (stays at root — muscle memory)
├── release.sh            # release pipeline (both products)
├── keys/                 # release minisign PUBLIC keys — public raw-URL path,
│                         # do not move (lunad fetches keys/ over HTTP at runtime)
└── .cursor/              # Cloud Agent environment definition
```

**Public paths that must not move** (consumed by released artifacts/users):
`install.sh` → now `sol/install.sh` (README updated), `keys/*.minisign.pub`
(lunad's updater fetches `raw/branch/main/keys/<name>`).

## Quick Reference

| Command | Description |
|---------|-------------|
| `./ci` | Interactive CI runner (auto-builds if needed) |
| `./ci run -profile full` | Run full CI suite non-interactively |
| `./ci run -profile libreserv` | LibreServ release gate (backend + frontend; no Luna/Connect) |
| `./ci run -profile luna` | Luna only (`luna/ci.sh`: Rust, web, desktop, mobile) |
| `cd sol/server/backend && make lint` | Format check + vet Go code |
| `cd sol/server/frontend && npm run lint && npm run typecheck` | Lint + typecheck frontend |

---

## Conventions (all products)

### PLAIN LANGUAGE (non-negotiable)

Our users are **not technical**. The product goal is "99% of users shouldn't need a terminal." Write **simple** copy — short sentences, what to do next, why a field exists. Simple is **not** baby talk. Do not invent household metaphors that dodge ordinary words.

**The point of this rule:** never dump a ritual like `curl -xOStR https://connect.com` and "now find the CORS header" into the UI. The point is **not** to replace `router`, `ethernet`, `admin`, or `read` with a euphemism.

**If a term needs a definition, define it:**

- In the sentence: `Plug Luna into your router or modem with the included RJ45 (ethernet) cable.`
- With **InfoHint** (`ⓘ`, longer aside next to a label) or **TermHint** (dotted underline on one word) from `src/components/ui/Tooltip.jsx`. Duplicate that file in Luna web and LibreServ web — keep them in sync.

Rules that still hold:

- **Never** expose raw technical terms **without a gloss** (parenthetical, InfoHint, or TermHint)
- **Never** assume the user knows where to find a credential, what a protocol does, or what an error code means
- **Always** explain what to **do**, not just what went wrong. A bad error: `"SMTP connection refused"`. A good error: `"Could not connect to your email provider. Check that the server address and port are correct in Settings → Email."`
- **Always** explain where a value comes from before asking for it. A bare input field labeled "API Token" is a failure. Say: `"Your API token is on cloudflare.com → Profile → API Tokens → Create Token."`
- **Always** explain why something is needed, not just what it is. A user doesn't care what DNS is — they care that `"We need this so your apps can be reached at addresses like nextcloud.yourdomain.com instead of a numbered IP address."`
- Terms that usually need a gloss at point of use: SMTP, SSH, DNS, ACME, TLS/HTTPS, CSRF, JWT, port, subdomain, Caddy, Podman, API, webhook, OIDC, DNS-01, DDNS, RJ45, ethernet (when first used)

This applies to frontend UI, API error messages shown to users, and any documentation a user might see. It does **not** apply to code comments, log entries, or internal developer docs. Dashboard greetings (pigeons, snacks) are personality — leave them. Role names, permissions, and setup instructions are not a place for personality.

#### WALL OF SHAME — oversimplified language

These showed up in product UI. Do not write them again. Use the replacement (and a tooltip when the real word needs a gloss).

| Shame (never ship) | Why it failed | Use instead |
|---|---|---|
| Takes care of Luna / Takes care of this Luna | Role is Admin, not a babysitter | `Admin` + InfoHint: who can add users, change settings, and manage this Luna |
| person who takes care of this Luna | Same dodge | `admin` / `an admin` |
| Household (as a role badge) | Vague; sounds like a species | `Member` |
| Can look / Can add and change | Read and Write already exist | `Read` / `Write` + TermHint |
| internet box | People own a router or modem | `router or modem` + TermHint on `router` |
| LAN socket — the same kind of socket your home internet uses | Talks around the cable in the box | `RJ45 (ethernet) cable` + TermHint on `RJ45` |
| Spare copy in the cloud | Avoids the word backup | `Cloud backup` + InfoHint if you need to explain off-site copies |
| Apps and helper tools | Nobody knows what a helper tool is | `Apps and access tokens` |
| Luna is asking this drive how it feels | Drive health is not a mood | `Checking this drive's health` |
| this box (for the Luna device, in settings) | We already named it Luna | `Luna` / `this Luna` |
| Couldn't do that | Says nothing | Name the action that failed and what to try |

Good: `Plug Luna into your router or modem with the included RJ45 (ethernet) cable.`
Bad: `Connect Luna to the internet box with the included cable. Use a LAN socket — the same kind of socket your home internet uses.`
Also bad: `ssh into the box and journalctl -u caddy until the ACME DNS-01 challenge succeeds.`

#### WALL OF SHAME — cachebusters in production

Do not append manual version query strings to static asset URLs in production builds.

| Shame (never ship) | Why it failed | Use instead |
|---|---|---|
| `favicon.svg?v=6` on production | Vite content-hashes built assets; query cachebusters pollute URLs, break CDN caching semantics, and look amateur | Clean paths (`/favicon.svg`); rely on build hashes or proper `Cache-Control` headers |

### Frontend (all web UIs)

- File extensions: `.jsx` (not `.tsx`) — but `npm run typecheck` still validates via JSDoc/TS-check
- Test runner: **Vitest** (not Jest), uses `@testing-library/react` + jsdom
- Import order: React → Third-party → Local (include `.jsx` extension in imports)
- Run `npm run scan:colors` when modifying UI to detect hardcoded colors
- The same component set exists in `sol/server/frontend` and `luna/web` — fixes to shared components (`PageNotice`, `Table`, `Tooltip`, `HeaderCard`, `Page`, Dropdown, settings categories) must land in **both** copies. (A shared package is on the roadmap; until then, sync by hand.)

#### Form field focus (non-negotiable)

Users find Tailwind **focus rings on text boxes intrusive** when clicking with a mouse. Form fields must not show a ring/outline on mouse focus.

**Rules for `input`, `textarea`, and `select`:**

- **Never** use `focus:ring-*` on form fields — mouse clicks must not draw a ring.
- **Do not add** `focus:ring-*` to form fields unless the user explicitly asks for it.
- Prefer a **border change** on focus (`focus:border-accent`) for subtle mouse feedback.
- **Keyboard accessibility is mandatory:** rely on the global `:focus-visible` outline in `index.css`, or add `focus-visible:border-*` when a field uses `no-focus-outline` (e.g. inputs embedded in pills/search bars).
- Buttons, links, toggles, and dropdown triggers **may** keep `focus-visible:ring-*` — the ban applies to **text boxes and other form fields only**.
- Shared `Input`/`Textarea` components and global base styles in `index.css` enforce this; do not override with per-field rings.

### Design / Theme

**This is a recurring failure mode. Agents repeatedly break contrast and abandon the design system, producing invisible text and flat boxes. Default HARD to these rules; question any deviation out loud before shipping.**

Before ANY UI work:
1. Read the branding repo: https://gt.plainskill.net/LibreLoom/design ("Simplex Mono" design language across all LibreLoom products)
2. Run `npm run scan:colors` after editing to catch hardcoded colors

#### 1. Standardized colors only
- Use theme tokens, NEVER hardcoded hex values. Tokens: `bg-primary` (page bg), `bg-secondary` (surface), `text-secondary` (text on primary bg), `text-primary` (text on secondary bg), `bg-accent` (#767676 both modes), plus `text-success`/`text-error`/`text-warning` for status.
- Theme uses CSS custom properties that swap on `.dark` class:
  - `--primary` = page background (white/light, black/dark)
  - `--secondary` = text color (black/light, white/dark)
  - `--accent` = subtle highlights (#767676 both modes)
- Tailwind maps: `bg-primary`, `text-secondary`, `bg-accent`, etc.

#### 2. Contrast from base colors FIRST
- **CRITICAL**: every colored surface must set its own contrasting text token on the SAME element — never rely on inheritance across a bg change.
  - `bg-secondary` surface → `text-primary`
  - `bg-primary` surface → `text-secondary`
- **Contrast is not automatic**: components are NOT automatically assigned a contrasting color; it must be set manually per component. This is the #1 invisible-element bug class — a `bg-secondary` panel without `text-primary` renders dark-on-dark in dark mode.
- Cards on `bg-primary` use `bg-secondary text-primary`. On `bg-secondary` surfaces, use `text-primary`. On `bg-primary` surfaces, use `text-secondary`.

#### 3. Prefer full-opacity colors
- **Default to full-opacity tokens.** Use `text-primary`, `text-secondary`, `bg-primary`, `bg-secondary`, `bg-accent` at full opacity — NOT `text-primary/70`, `text-secondary/50`, etc. Opacity modifiers (`/70`, `/50`, `/10`) are a common cause of low-contrast text. Reach for them only when you have a concrete reason (a status tint surface), never as a default for body text, labels, or hints.
- Opacity is for status/tint surfaces only, not a crutch for indecision or "muted" text. If text looks too loud, pick a different token — don't dial down the opacity.
- Status tint pattern: `/20` fill + `/30` border (e.g. `bg-success/20 border-success/30`, `bg-error/20 border-error/30`).
- Do not sprinkle opacity everywhere as a substitute for choosing the right base token.

#### 4. Layered, pill-based, innovative & animated
- Lean into the design language — this is a deliberate aesthetic, not generic Bootstrap. Push toward the distinctive layered + pill + animated look; do NOT flatten to plain boxes.
- **Layering**: surfaces inside surfaces, each panel setting explicit contrast on itself. Layered depth, not a single flat card.
- **Pills**: `rounded-pill` (9999px) for buttons/chips/badges/pills; `rounded-large-element` (24px) for cards/containers/rows. Border radius: pill `9999px`, card/large `24px`.
- **Animation**: intentional motion/transitions on state changes (hover, open/close, loading, status swap). Motion should feel crafted, not absent.
- **One outline per element**: never stack a `border` and a `ring` (or two rings) as simultaneous visible outlines — that's the banned double-outline look. `border` is for persistent state, `ring` for transient affordances (hover, drag target). Keep the border width (`border-transparent`) for size stability when the resting border is hidden. `focus-visible` rings for keyboard a11y are allowed.

#### 5. Preserve monospace style
- Simplex Mono is the brand identity. Typography: monospace for headings/code (FreeMono / monospace family like Courier New), Noto Sans for body. Keep the mono typography identity — do NOT replace with a generic sans-serif.
- **No bold monospace — ever.** Monospace text is always regular weight. Never combine `font-mono` with `font-medium`/`font-semibold`/`font-bold`, and never wrap `font-mono` text in `<strong>`/`<b>` without `font-normal`. Emphasize mono text with size, case, tracking, or color instead. Tabular data (e.g. CSV previews) renders in sans; only the header row stays mono.

#### Haptics & Tactile Feedback (non-negotiable)

The entire UI must be felt, not just seen. Every interactive surface, card, modal, gesture (long-press, swipe, drag/drop, FAB corner snap), navigation link, and state outcome (shake error, copy success, mutation success) must emit consistent, intentional, and tasteful tactile haptic feedback using Luna's PWM-modulated vibration engine (`luna/web/src/utils/haptics.js`).

**Semantic presets (use explicitly):**
- `selection`: Segmented controls, tabs, nav links (`NavLink`), table rows (`onRowClick`), checkboxes, dropdown items, filter toggles, photo thumbnails, year/month scrubbers.
- `light`: Micro-interactions, gentle UI toggles, tooltip pins (`InfoHint`/`TermHint`), password reveal eye toggle, search open/close/clear, filter chip dismissal, accordion expand/collapse, pill action button clicks.
- `medium`: Substantial actions, card buttons, opening files/folders, lightbox opens, custom bounding box draws, library rescans, device token removal.
- `heavy`: High-gravity events, file drops in folders or upload dropzones.
- `rigid`: Physical resistance, boundary snap, drag starts, swipe resistance past library edges, FAB corner latching, long-press threshold activation.
- `success`: Positive outcomes, save completed, album created, file/folder mutation done, login success, setup completion (`STEP.DONE`), copy to clipboard.
- `warning`: Destructive or high-impact prompts opening (`ConfirmModal` danger/warning variants, trash prompts).
- `error`: Synchronous validation errors and alerts (wired directly to `shakeElement()`), API mutation failures, clipboard copy rejections.

**Rules for haptics:**
- **Synchronize with visual animation**: E.g. `shakeElement()` automatically triggers `haptic("error")` synchronously with the CSS shake animation; FAB corner latching triggers `haptic("rigid")` on physical snap.
- **No passive buzzing**: NEVER vibrate on hover, passive page scrolling, or regular text input keystrokes.
- **No double-buzzing**: If a button click already gave feedback, don't buzz again for the immediate action unless it's a distinct asynchronous completion (e.g. async mutation `onSuccess` / `onError`).
- **Respect user settings**: Always route through `haptic()` which honors `luna_haptics_enabled` in localStorage.

- No `.gz` pre-compression needed — Vite build already generates `.gz` alongside files; backend serves them when client sends `Accept-Encoding: gzip`

### Git
- **THE REMOTES ARE ONE REPOSITORY.** This repo is mirrored across forges: `origin` (GitHub) and `forgejo` (`gt.plainskill.net`) point at the SAME project, and a mirror keeps them identical. `origin/main` and `forgejo/main` are the same history — the git objects are one. Do NOT treat them as separate remotes:
  - Fetch once, from the branch's upstream remote (usually `origin`). Do not `git fetch` every configured remote.
  - Merge/rebase/diff against that ONE remote-tracking branch. Never merge both `origin/main` and `forgejo/main`, and never reason about them as possibly-divergent.
  - Never remark that the remotes are on the same commit — that is the expected state, not a coincidence worth reporting.
- **Push to one forge only.** Commits and branches pushed to one forge are copied to the others by the mirror. Push once to the branch's upstream remote (usually `origin`), then stop.
- **Git tags do not sync across platforms.** A tag pushed to GitHub (e.g. `luna-connect-v0.2.28`, `luna-v0.0.26`) will **not** appear on Forgejo or GitLab via the mirror. Hosts that pull Forgejo (e.g. Luna Connect at `/opt/LibreServ`) will not see GitHub-only tags. Push release tags to the forge the consumer actually fetches, or deploy with `deploy.sh --head` / an explicit SHA until that forge has the tag.
- **Do not** dual-push the same commit or branch to a second forge "so it shows up faster." That races the mirror and can break sync. Tags are the exception only when a consumer forge is missing a release tag it needs (see above).
- If Forgejo (or another forge) looks behind on **branches** after a GitHub push, **wait for the mirror** — do not dual-push commits to catch it up.
- Conventional commits: `feat(scope): description`, `fix(scope): description`
- Branch naming: `feat/{desc}`, `fix/{desc}`, `docs/{desc}`, `chore/{desc}`

### Cursor Cloud environment
- `.cursor/environment.json` + `.cursor/install.sh` provision the dev stack automatically: Go 1.26 (the repo needs it; the base image ships older Go), Podman + `podman-compose` (CI and app runtime tests; `start.sh` starts the API socket because Cloud Agents often have no user systemd bus), backend config/modules/restic, frontend deps + build, Rust 1.96 + Luna lunad/web deps, and the `fj` CLI. `terminals` run LibreServ backend (`make run`, `:8080`) and Vite (`npm run dev`, `:3000`), plus Luna lunad (`LUNA_CONNECT_URL=http://127.0.0.1:18765 make dev-daemon`, `:8090`) and Luna Vite (`npm run dev`, `:3001`).
- **Luna Connect mock (Cloud Agents):** `.cursor/start.sh` runs `luna/scripts/seed-mock-connect.sh`, which starts the mock on `:18765`, sets subdomain `max` → `max.luna.servers.libreloom.org`, unlocks cloud backup, and mints `luna/dev/device-token` when missing. Override with `LUNA_MOCK_SUBDOMAIN` / `LUNA_MOCK_DOMAIN`. Control with `make -C luna mock-connect ARGS="status|domain set …|backup unlock|…"`. See `luna/README.md` → Luna Connect Mock.
- `.cursor/start.sh` authenticates `fj` from the `FORGEJO_TOKEN` secret for Forgejo comments and issues. Without the secret, `fj` stays unauthenticated. Git remotes are left as Cursor provisioned them.

## Notes for Agents

- **Go versions are real.** The Go version declared in this repository (currently 1.26) exists in real life — not just in this project's environment. Do not question whether `golang:1.26-alpine`, `golang:1.26-bookworm`, or any other Go 1.26 image is available: it is. Treat Go toolchain versions mentioned in this repo as unconditionally available.
- **This project is in early development. There are no existing users.** Do not worry about backwards compatibility, migration paths, or deprecating old fields smoothly unless explicitly asked. When the backend or design changes, obsolete frontend concepts can be torn down completely without guarding for legacy state. The AI model fields that exist now are `main_model` (agent model), `review_model` (safety review model), `summary_model` (optional model that summarizes the session so the reviewer has context), and `review_enabled` (whether tool-call review runs). `default_model`, `agents[]`, `snapshot_before_writes`, `credit_cap`, and similar old concepts are fully dead.
