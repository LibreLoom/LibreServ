# Common brief for Protect-rebuild worker agents

You are one of several agents building Luna's new backup system in parallel. Another agent (the orchestrator) assigns tasks, reviews and commits.

## Hard rules
- Edit ONLY the files your task names. Other agents are editing other files at the same time. If you believe another file must change, do not change it: say so in your report.
- Do NOT commit, branch, stash, reset or run `git checkout`. Do not run `npm install`.
- The repo is at `/var/home/plainskill/Projects/LibreServ`. Luna's Rust daemon is `luna/crates/lunad`, shared lib `luna/crates/luna-core`.
- Match surrounding code style: comment density, naming, error handling (user-facing errors are plain-language sentences; see existing `anyhow::bail!` messages in `luna/crates/lunad/src/backup/protect.rs`).
- Early development: no migrations, no backwards compatibility.
- Read only what you need. Your context is limited (~100k tokens): use `grep -n` and `sed -n 'A,Bp'` to read parts of large files instead of whole files.

## The plan
Full design: `/var/home/plainskill/.claude/plans/protect-rebuild.md`. Read only the sections your task cites.

## Building and testing
- Quick compile check on the host: `cd /var/home/plainskill/Projects/LibreServ/luna && cargo check -p lunad 2>&1 | tail -40`
- Tests must run in the `dev` distrobox (host has no linker):
  `distrobox enter dev -- bash -lc 'cd ~/Projects/LibreServ/luna && CARGO_TARGET_DIR=target/dbx cargo test -p lunad --lib <filter> 2>&1 | tail -40'`
- Bash output starts with harmless "Missing requirements"/`_encode` noise. Ignore it.
- Other agents compile at the same time. If the build fails in a file you did not touch, note it and judge your own code by its own errors.
- A new module must be registered in its parent `mod.rs` to compile. If your task says you own that line, add it.

## Report back (keep it under 300 words)
- Files changed, public functions/types you added (signatures).
- Test results (command + pass/fail counts).
- Anything you could not do, and any file outside your list you think must change.
