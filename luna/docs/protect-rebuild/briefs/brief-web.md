# Common brief for web worker agents (Luna web)
- Read the repo rules first: `/var/home/plainskill/Projects/LibreServ/AGENTS.md` sections "Plain language", "Frontend", "Design / Theme", "Haptics". They are strict; follow them literally (tokens only, Button `surface` naming its backdrop, sentence case, no font-mono+bold, InlinePill for names in copy, toasts only for user actions).
- App: `luna/web` (React 19, Vite, Tailwind 4, TanStack Query, Vitest). Shared components: `shared/ui` (`@libreloom/ui/...`) — use, never edit.
- Edit ONLY files your task names. Other agents edit other files concurrently. Do NOT commit, branch, stash, reset, `git checkout`, or `npm install`.
- The backend API is being built at the same time; code against the API described below and mock fetch in tests the way neighbouring tests do.
- Context is limited (~100k tokens): read big files in slices (`grep -n`, `sed -n 'A,Bp'`).
- Check: `cd /var/home/plainskill/Projects/LibreServ/luna/web && npx vitest run <your test files> 2>&1 | tail -30`, `npm run lint 2>&1 | tail -20`, `npm run scan:colors 2>&1 | tail -20`, `npm run typecheck 2>&1 | tail -20` (judge only errors in your files).
- Every new component gets a render test (contrast checks run on whatever renders).
- Report under 300 words: files changed, test results, anything outside your files that must change.

## Backend API (phase 1, drive backups only; cloud backup still uses the old `/api/v1/connect/...` endpoints, leave those alone)
Backup object `B`: `{id, kind:"drive", source_drive, source_drive_name, source_path, source_name, target_drive, target_drive_name, state:"ok"|"failing"|"stale", status:"active"|"stopped"|"source_gone", stop_reason, last_ok_at (unix s, 0 = never), last_error, hard (bool), first_done (bool), created_by, can_delete}`
- `GET /api/v1/backups` → `[B]` the user can see. `?drive=<id>&path=<p>` → only backups of exactly that source.
- `POST /api/v1/backups` `{source_drive_id, source_path, target_drive_id}` → `B` (first run starts in background). Errors are plain sentences (`apiErrorMessage`).
- `DELETE /api/v1/backups/{id}`.
- `POST /api/v1/backups/{id}/run` `{allow_mass_delete?: bool}` → `{done: bool}` (false = still copying).
- `GET /api/v1/drives/{drive}/backups` → `[{id, source_name, source_drive_name, source_path, last_ok_at, status, size_bytes}]` stored on that drive.
- `GET /api/v1/drives/{drive}/backups/{id}/list?path=<rel>` → `[{name, is_dir, size, mtime, deleted?, deleted_at?}]`
- `GET /api/v1/drives/{drive}/backups/{id}/versions?path=<rel file>` → `[{at (unix s or null = current), size, mtime}]` newest first.
- `GET /api/v1/drives/{drive}/backups/{id}/download?path=<rel>&at=<t?>` → file, or zip for a folder.
- `POST /api/v1/drives/{drive}/backups/{id}/restore` `{path, at?}` → `{name}` (final restored name). 409 with a sentence when the original drive isn't connected.
