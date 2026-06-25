# Audit Findings — UNVERIFIED

> Generated 2026-06-24 from two model runs used as a **test prompt**.
> **Nothing below has been checked against the actual codebase.** Line counts,
> file lists, "17 files," stub claims, and coverage numbers may be stale or wrong.
>
> Triage before acting: verify each item against the real code, promote the real
> ones into `ROADMAP.md` / issues, and delete the false ones. Then delete this file.

---

## 🔴 Release blocker (verify FIRST)

- **AI support agent bash tool = LLM-gated root shell, no real sandbox.**
  `internal/agent/tools/bash.go` + `internal/agent/loop.go` run arbitrary shell
  (`exec.CommandContext(ctx, "bash", "-c", cmd)`) as the server process with
  `HOME=/root` and a full PATH incl. `/sbin`. The only gate is a second LLM
  (review model, `AlwaysReview: true`). No container / namespace / seccomp /
  allowlist / syscall filter. `workdir` is taken verbatim from the model.
  - **Worse:** the code comments *claim* a sandbox that doesn't exist —
    `bash.go` says it "enforces basic guardrails (timeout, no interactive,
    sandbox paths)" (no path sandboxing exists); `review.go` says
    "OS-level sandboxing is the real security boundary" (it isn't).
  - Impact for a product targeting non-technical home users: prompt injection
    in any tool-readable data (app logs, fetched web content, chat) → root RCE.
    "Security by LLM" is not a defense against prompt injection.
  - Fix before any user-facing release: real OS-level boundary (run agent
    commands in a restricted Podman container / bubblewrap + read-only roots +
    allowlisted binaries), or drop the bash tool for non-admin sessions.

---

## 🟠 Release pipeline / CI

- `gofmt -l .` reportedly flags ~17 unformatted files (incl. `router.go`,
  `server.go`, `manager.go`, `installer.go`). `make lint` (gofmt + go vet)
  would fail; reportedly committed on `main` anyway.
- `./ci run -profile full` reportedly did not finish within 5 min in one test
  run and is not a trustworthy green/red signal. Need a fast required profile
  (~5–10 min) with fuzz/security/e2e split into optional/nightly.

---

## 🟠 Product vs. docs drift

- `AGENTS.md` claims **7 built-in apps** (nextcloud, searxng, ollama, convertx,
  motioneye, homeassistant, librechat) but `server/backend/apps/builtin/`
  reportedly contains only `apprun-test`. Either restore real apps or correct
  the docs/roadmap. (Big product-readiness gap, not just a doc typo.)
- Stubs / not-implemented: ACME cert revocation, UPnP service,
  `users.InviteUser`.

---

## 🟡 Code quality / conventions

- **Plain-language rule unenforced.** AGENTS.md headline: "99% of users
  shouldn't need a terminal," never expose instance ID / SMTP / etc. bare.
  But API errors are terse/technical across ~470 `JSONError` call sites, e.g.
  `"instance ID is required"`, `"App not found"`, `"Failed to retrieve apps"`.
- **Duplicate wiring:** ACME manager setup reportedly appears in both
  `cmd/libreserv/main.go` and `internal/api/router.go` → drift risk between
  background jobs and API handlers.
- **Cruft committed:** `FeatureMatrix.jsx.bak`, `ConfigFieldRenderer.jsx.bak`
  (the `.bak` differs from live only by added JSDoc — stale backup);
  `NotFoundPage.jsx` is ~476 lines for a 404 (likely holds unrelated logic).
- **SQL identifier interpolation** (legit pattern, but audit):
  `factory_reset.go:~113`, `migrate.go:~502`, `security/service.go:~519`.
  Confirm user input goes through `?` placeholders, not concatenation
  (esp. the dynamic WHERE in `security/service.go`).

---

## 🟡 Testing gaps

- Frontend coverage ~11% (25 test files / ~219 source). Backend tests reported
  healthy (~508 tests incl. integration + fuzz + race); backend coverage ~24.5%,
  connect ~36.4%.
- Low E2E coverage for critical owner flows: setup → login → install app →
  backup → restore → uninstall; also domain/HTTPS setup, factory reset,
  agent tool boundaries. One happy-path E2E flow is worth more than narrow units.

---

## Complexity hotspots (consider splitting)

- `internal/apps/manager.go` ~1688
- `server/frontend/src/pages/SetupPage.jsx` ~1574
- `internal/network/caddy.go` ~1221
- `internal/apps/installer.go` ~1169
- `internal/storage/backup.go` ~1106

---

## Reported ratings (two test runs — for reference only)

- Run T: overall **6.8/10** — product readiness 5.5, CI/release 4.5, testing 6,
  security 6.5, architecture 7.5. Verdict: "solid prototype/MVP, not
  production-ready."
- Run H: overall **~7/10** — held back by the agent-sandbox release blocker;
  praised error discipline (0 ignored errors, ~1925 `err != nil`, ~470
  `JSONError`, ~8 `http.Error` bypasses), clean build/vet/tests, CSRF done right.