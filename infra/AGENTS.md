# AGENTS.md - infra

Shared tooling: the CI runner, release pipeline, repo automation bots, and
process docs. Product code lives in `sol/` and `luna/` — this area is the glue.

## Layout

```
infra/
├── ci-source/      # ./ci runner source (Go). Binaries gitignored;
│                   # the root ./ci launcher rebuilds when sources change.
├── agents/         # automation bots: atlas-bot, docs-bot, lock-bot
│   ├── common/     # shared machinery: loop.sh, forgejo.sh (BOT_NAME-
│   │               # parameterized), log_dsh_events.mjs, dsh-home/,
│   │               # git-sync.sh — edit here, not per-bot
│   └── <bot>/      # per-bot: cook.sh body, prompt.md, compose.yml,
│                   # docs, bot-specific tools. loop.sh is a stub that
│                   # execs ../common/loop.sh — keep it (deployed compose
│                   # files exec the per-bot path).
├── docs/           # process docs (RELEASE-PLAN.md, …)
└── AGENTS.md

# plus, at repo root:
./ci                # launcher — builds infra/ci-source/bin/ci-<os>-<arch>
release            # release tool launcher (builds cmd/release in a Go container)
keys/               # release signing keys — public raw-URL path, do not move
```

## CI

- `./ci` is a custom Go binary that runs tests in containers via **Podman** (not Docker). The runner connects to Podman's Docker-compatible socket (rootless `$XDG_RUNTIME_DIR/podman/podman.sock`, then rootful, then Docker fallback) and starts `systemctl --user start podman.socket` if needed. Bind mounts use the `:z` SELinux relabel (required by Podman rootless on this SELinux-enforcing host).
- The `./ci` launcher builds `infra/ci-source/bin/ci-<os>-<arch>` from source and **auto-rebuilds it when any `ci-source/*.go` is newer than the binary** — binaries are gitignored, edits are picked up on the next `./ci` run. Prebuild all platforms with `infra/ci-source/build.sh`.
- Test definitions live in `infra/ci-source/internal/tests/registry.go` — `WorkDir` values are container paths under `/repo/` (e.g. `/repo/sol/server/backend`, `/repo/luna/connect`). `findRepoRoot` detects the checkout by looking for `sol/server/` + `sol/connect/`.
- The `podman-build` test uses `Container: "host"` (SELinux blocks mounting the podman socket into a container). No GitHub Actions — all CI is local.
- There are no E2E (Playwright) tests.

## Releases (`./release`, repo root)

- Two product lines: `v*` tags = Sol, `luna-v*` tags = Luna. The Connect servers deploy from the signed feeds, not tags — `connect-v*` / `luna-connect-v*` are retired.
- Luna release assets: lunad binary, OS slot image, factory ISO, Flatpak, Windows installer (MinGW cross + NSIS, unsigned — SmartScreen warns), signed Android APK.
- Android APK: signed when `LUNA_ANDROID_KEYSTORE`/`_B64` + passwords are in env, else debug-signed fallback with a warning. F-Droid builds/signs its own from the `luna-v*` tag.
- Minisign secrets resolve per product: `LSLUNA_RELEASE_MINISIG_PK` / `SOL_RELEASE_MINISIG_PK` env, `MINISIGN_SECRET_KEY` (path or contents), then `~/.minisign/*.key`. Public keys committed in `keys/` at root — the path is public API (Sol and lunad embed them at build time; the Connect deploy script and Flatpak repo server read them from the checkout).
- See `docs/RELEASE-PLAN.md` for the release and update design.

## keys/

Release signing keys only — `*.minisign.pub` and the Flatpak repo's `luna-desktop-flatpak.gpg` committed, `*.key` / `*_B64` secrets never. `keys/lsluna.minisign.pub` is embedded into lunad at build time (`include_str!`) and verifies the signed release feed — the directory must stay at repo root.
