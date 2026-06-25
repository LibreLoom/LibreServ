# LibreServ Goals

This is the single source of truth for **what we're building** and **what's left**.
It's a goals checklist, not a granular task tracker — issues and `git log` are the
record of how things actually got done.

**How to use it:**

- Working on something? Check the box when it's merged to `main`.
- Starting something? Make sure it isn't already done here.
- Status reflects **merged reality**, not hopes. If a box is checked but the feature
  is broken, uncheck it.

Just Markdown checkboxes: `[x]` = done and on `main`, `[ ]` = not yet. No task
numbers, no ownership columns, no "in progress" hand-edits. Keep it honest and move on.

---

## The critical path

The flow that matters above all else — if any step is broken, nothing else does:

```
User gets hardware → powers on → opens browser → setup wizard →
creates admin → installs an app → it works → creates a backup → done
```

Every goal below exists to keep this path smooth and safe for a non-technical user.

---

## First-run experience
*A user powers on and completes setup without a terminal.*

- [x] Setup wizard guides the user through creating the admin account
- [x] Preflight checks verify container runtime, disk space, and database before first use
- [ ] A user can set up shipped hardware end-to-end with no technical help
- [ ] Domain + HTTPS offered as part of first-run (see Remote access)

## App management
*The core promise: install and run apps without difficulty.*

- [x] User can install any app from the catalog
- [x] User sees plain-language warnings about app features (shared accounts, external auth)
- [x] User can start, stop, and restart installed apps
- [x] User can uninstall apps with confirmation
- [ ] Curated app catalog served from the official app repo (nextcloud, searxng, ollama, convertx, motioneye, homeassistant, librechat); this repo ships only `apprun-test` as a reference app today

## Backups & recovery
*Actions should be reversible.*

- [x] User can create a backup of any installed app
- [x] User can restore from an existing backup
- [x] User can configure automatic cloud backups (Backblaze B2 or S3)
- [ ] Backup system revamped for scale (current implementation works but isn't scalable)

## Remote access
*A domain of your own, with HTTPS that just works.*

- [ ] User can configure a domain for remote access
- [ ] HTTPS is automatically configured and renewed
- [ ] User can add custom domain routes to apps
- [x] DNS provider integration (Cloudflare)

## System health & users
*User confidence and multi-user households.*

- [ ] User can check system health and resource usage
- [x] User can add and manage multiple users
- [x] User can update LibreServ from the web UI

## BLE companion (offline access)
*Reach the Web UI over Bluetooth when Wi-Fi isn't available.*

- [ ] Linux companion (GTK4/libadwaita) — in progress
- [ ] Android companion — deferred

## Production readiness
*Must be true before we ask non-technical people to trust this with their data.*

- [ ] `./ci run -profile full` gives a fast, trustworthy green/red signal (currently slow/unreliable)
- [ ] `make lint` (gofmt + go vet) passes clean on `main`
- [ ] Plain-language rule enforced across API error messages, not just the UI
- [ ] End-to-end happy-path E2E covers the critical path (setup → login → install → backup → restore → uninstall)

---

## Beyond MVP

Things we want eventually, not blocking MVP. Sketches, not commitments:

- Infrastructure-scale (multi-drive storage)
- Advanced admin features

A richer app ecosystem and third-party app packaging live in the separate official app repo, not here.

When one of these becomes real work, promote it into a section above with its own
checkboxes.

---

## A note on accuracy

If a box here disagrees with the code, **the code wins** — fix the box. This file is
maintained by hand and will drift; treat it as a map, not the territory.
`AUDIT-FINDINGS.unverified.md` is a separate, unverified triage scratch file — don't
confuse the two.