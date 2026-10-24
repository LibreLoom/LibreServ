# Rules for agents working on the states feedback

Several agents edit this checkout at the same time. These rules keep you from breaking each other's work.

1. Read `/home/plainskill/Projects/LibreServ/AGENTS.md`, and `luna/AGENTS.md` if you touch luna. Its plain-language,
   design, haptics and toast rules apply to everything you write.
2. **No test runners at all.** Don't run `cargo test`, `vitest`, `npm test`, `npx vitest` or `./ci`. The orchestrator runs
   `./ci` once everyone is done. You MAY run: `cargo check -p <crate> --tests`, `npm run typecheck`,
   `npm run scan:colors` and `npm run lint` (in `luna/web`), and `rustfmt --edition 2024 <your file>`.
3. **No git writes.** Don't run add, commit, stash, checkout, restore, reset or rebase. Don't commit; the orchestrator commits
   your files. Read-only git (`status`, `diff`, `log`, `show`) is fine.
4. **Touch only the files your brief lists as yours.** If you need another file, stop and say so in your
   report; don't edit it. Never run `cargo fmt` or a repo-wide formatter or search-and-replace, because other agents' files are open.
5. Other agents are editing other files in the same crate or app. If `cargo check` or `typecheck` fails **only**
   in files you don't own, that isn't yours: note it and carry on. Errors in your files are yours to fix.
6. Frontend: every new or changed component gets a render test (vitest + Testing Library, `.test.jsx` next to
   it). The contrast and surface checks only see what a test renders. Write the tests, but don't run them.
7. Rust: add unit tests for new behaviour, but don't run them.
8. **Final report:** the exact files you changed, what each change does, what you couldn't verify, and any
   problem or open question (for example a real bug you found but were told not to fix).
