# Contributing to LibreServ

Two ways to get code in, depending on your access:

- **You have push access** (approved contributors / maintainers) → push to `main`.
  Use a branch for anything non-trivial, but no PR required.
- **You don't** (everyone else) → fork, branch, open a Pull Request.

That's the whole flow. The rest is conventions to keep things consistent.

---

## Before you push / open a PR

Run the checks locally so CI doesn't catch what you could've caught:

```bash
# Backend (Go)
cd server/backend
make lint          # gofmt + go vet
make test          # unit tests

# Frontend (React/Vite)
cd server/frontend
npm run lint
npm run typecheck
npm test

# Everything (custom CI runner)
./ci
```

See [`AGENTS.md`](AGENTS.md) for architecture, conventions, and how to run the stack.

---

## Push-to-main (contributors with write access)

1. Make sure `main` is green and you're up to date.
2. Do the work. Branch if it's more than a trivial change (`feat/…`, `fix/…`, `docs/…` — see naming below), then merge or fast-forward to `main`.
3. Run the checks above.
4. Push to `main`.
5. Commit message follows conventional commits (below).

Use good judgement: for large or risky changes, a PR for review is still a good idea
even if you can push directly. Pushing to `main` is a convenience, not a licence to skip
review when review would help.

## Pull requests (everyone else)

1. Fork the repo on [Forgejo](https://gt.plainskill.net/LibreLoom/LibreServ).
2. Branch from `main` (see naming below).
3. Do the work, run the checks above.
4. Push to your fork and open a PR against `main`.
5. Describe **what** changed and **why**. Link any related issue.
6. Address review feedback; a maintainer merges once approved.

---

## Conventions

### Branch naming (recommended, not enforced)

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/{short-desc}` | `feat/dark-mode` |
| Bug fix | `fix/{short-desc}` | `fix/login-redirect` |
| Docs | `docs/{short-desc}` | `docs/api-reference` |
| Chore | `chore/{short-desc}` | `chore/deps` |

### Commit messages (conventional commits)

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`.

Example:
```
feat(setup): add domain step to setup wizard
```

Keep the subject line short; put the *why* in the body.

### Code style

**Go:** `go fmt` before commit, `go vet ./...` clean. Module path
`gt.plainskill.net/LibreLoom/LibreServ`, router is `chi/v5`.

**React/Vite:** `.jsx` files (not `.tsx`), `npm run lint` + `npm run typecheck` clean,
follow existing patterns. Use the project `Dropdown` component over a raw `<select>`.

### The plain-language rule

LibreServ's users are not technical. User-facing strings — API error messages, UI
labels, help text — must be written for someone who doesn't know the acronyms. Explain
what to **do**, not just what broke. See [`AGENTS.md`](AGENTS.md) for the full rule; it
applies to API errors shown to users, not just the frontend.

---

## Where things live

- [GOALS.md](GOALS.md) — what we're building and what's left (the checklist).
- [AGENTS.md](AGENTS.md) — codebase guide, conventions, architecture.
- [docs/RELEASE.md](docs/RELEASE.md) — how we cut signed `v*` / `luna-v*` releases.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities, security model.
- [Issues](https://gt.plainskill.net/LibreLoom/LibreServ/issues) on Forgejo — bugs, feature requests, questions.
