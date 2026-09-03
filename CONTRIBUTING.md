# Contributing to LibreServ

We move fast and break things. Preferably other people's assumptions, not
production, and definitely not the security model.

Two ways to get code in. Access decides which one you use:

- **You have push access** (approved contributors / maintainers) → you may push
  to `main`. Branch anything that isn't trivial. No PR required.
- **You don't** (everyone else) → fork, branch, open a Pull Request.

That is the whole flow. The rest is how we keep the repo from turning into a
group project that never ships.

---

## Before you push or open a PR

Run the checks locally so `@fluffy-bunny-23`, lord of CI, does not publicly
shame you for something a TUI could have caught in private:

```bash
# Select the applicable tests for your changes after launching the CI TUI.
./ci
```

Architecture, conventions, and how to actually run the stack live in
[`AGENTS.md`](AGENTS.md). Yes, that file is mostly for agents. No, we do not
have a polished human manual yet. Sorry. Read it anyway — it is the closest
thing to a map.

---

## Push to `main` (write access)

You can push to `main`. That is the point. It is a convenience, not a dare.

1. Make sure `main` is green and you are up to date.
2. Do the work.
   - Tiny change: commit on `main` and go live your life.
   - Anything with a plot twist: branch it (`feat/…`, `fix/…`, `docs/…` — naming
     below), then merge or fast-forward onto `main`.
3. Run the checks above.
4. Write a conventional-commit message (also below). Humans have to read those
   later. Future-you is included.
5. Push to `main`.

If the change is large, weird, or the kind of thing that becomes a
vulnerability write-up, open a PR even though you do not have to. Review is not
bureaucracy here. It is how we avoid inventing a new class of incident.

Pushing to `main` means you used judgement. It does not mean you skipped the
part where you think.

---

## Pull requests (no write access)

1. Fork the repo on [Forgejo](https://gt.plainskill.net/LibreLoom/LibreServ).
2. Branch from `main` (see naming below).
3. Do the work. Run the checks. Yes, those checks.
4. Push to your fork and open a PR against `main`.
5. Describe **what** changed and **why**. Link the issue if there is one.
   "fixed stuff" is not a description. It is a cry for help.
6. Address review feedback. A maintainer merges once it is approved.

---

## Conventions

### Branch naming (recommended, not enforced)

Nobody is going to reject your branch because you named it `asdf`. We will
silently judge you.

| Type    | Pattern              | Example              |
| ------- | -------------------- | -------------------- |
| Feature | `feat/{short-desc}`  | `feat/dark-mode`     |
| Bug fix | `fix/{short-desc}`   | `fix/login-redirect` |
| Docs    | `docs/{short-desc}`  | `docs/api-reference` |
| Chore   | `chore/{short-desc}` | `chore/deps`         |

### Commit messages (conventional commits)

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`.

Example:

```
feat(setup): add domain step to setup wizard
```

Keep the subject short. Put the *why* in the body. The subject is the headline.
The body is how we forgive you six months from now.

### Code style

**Go:** `go fmt` before commit. `go vet ./...` clean. Module path
`gt.plainskill.net/LibreLoom/LibreServ`. Router is `chi/v5`. The compiler is
already sarcastic enough; do not give it extra material.

**React/Vite:** `.jsx` files, not `.tsx`. `npm run lint` and `npm run typecheck`
must be clean. Follow the patterns already in the tree. Use the project
`Dropdown` instead of a raw `<select>`, unless you enjoy rebuilding
accessibility from first principles for fun.

**Rust:** Match the crate you are standing in. `cargo fmt`. Keep `cargo clippy`
quiet if that crate already runs it. If you came here looking for a grand Rust
style treatise: there isn't one. Do what the neighboring files do and leave.

### The plain-language rule

LibreServ's users are not reading this document. They are trying to get
something done and the UI just said a sentence only a systems person would love.

User-facing strings — API errors, labels, help text — get written for a person
who does not know the acronyms. Tell them what to **do**, not just the name of
the wreckage.

Full rule is in [`AGENTS.md`](AGENTS.md). It applies to API errors shown to
users, not only the frontend. If a human can see it, write like a human.

---

## Where things live

- [GOALS.md](GOALS.md) — what we are building and what is still unchecked.
- [AGENTS.md](AGENTS.md) — architecture, conventions, how the stack runs.
- [docs/RELEASE.md](docs/RELEASE.md) — how we cut signed `v*` / `luna-v*` releases.
- [SECURITY.md](SECURITY.md) — how to report a hole instead of casually opening one.
- [Issues](https://gt.plainskill.net/LibreLoom/LibreServ/issues) on Forgejo —
  bugs, features, questions, and the occasional "is this on purpose."

---

Most of this file has been through a machine. This sentence hasn't.
If something here starts sounding like a policy wiki again, a human should
fix it. Just kidding. This one was through a machine too.