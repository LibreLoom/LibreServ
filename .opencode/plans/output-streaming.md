# Plan: Output Streaming (SSE) — Friendly Progress

## Context

The backend already has streaming infrastructure (`StreamExecute`, SSE handler at `scripts.go:240`) but the frontend never connects to it. The frontend uses synchronous `fetch()` everywhere — actions show a spinner then a complete result, and the install wizard shows fake progress phases with no real output.

**Userbase requirement:** LibreServ targets non-technical users. The default experience must be simple and friendly. Raw script output should be available but hidden behind a "View details" toggle for power users and debugging.

Two separate flows need streaming:
1. **Action scripts** — existing SSE endpoint, just needs frontend wiring
2. **Install/system scripts** — needs both new backend SSE endpoint and frontend integration

## Scope

| Flow | Backend work | Frontend work |
|------|-------------|---------------|
| Action streaming | Minimal — pass options as query params | New SSE client, update ActionOptionsModal |
| Install streaming | New SSE endpoint, output channel manager | Update ProgressStep with friendly progress |

---

## Phase 1: Frontend Streaming Infrastructure

### 1a. Create `useScriptStream` hook
**File:** `server/frontend/src/hooks/useScriptStream.jsx`

Reusable hook that consumes SSE streams via `EventSource`:
- `connect(url)` — opens EventSource connection
- Accumulates raw output lines from `ScriptOutput` messages (`{type, content, error, exit_code}`)
- Tracks connection state: `idle | connecting | streaming | complete | error`
- Auto-cleans up on unmount
- Returns: `{ lines, status, exitCode, error, connect, disconnect }`

### 1b. Create `ProgressFeedback` component
**File:** `server/frontend/src/components/common/ProgressFeedback.jsx`

Friendly progress display — defaults to human-readable status, raw output hidden:

**Default view (non-technical users):**
- Spinner or progress bar with friendly status message
- Status is generated from raw output via pattern matching:
  - `docker compose pull` → "Downloading application files..."
  - `docker compose up -d` → "Starting application..."
  - `system-setup` scripts → "Configuring application..."
  - Generic patterns mapped to plain language
- Show elapsed time
- On complete: green checkmark, "Setup complete ✓"
- On error: red icon, friendly error message ("Something went wrong. Tap 'View details' to see what happened.")

**Expanded view (power users / debugging):**
- "View details" button toggles raw output display
- Scrollable monospace terminal area
- Auto-scroll with "jump to latest" button
- Copy output button
- Collapses back to friendly view by default

**Props:**
```jsx
<ProgressFeedback
  streamUrl="/api/v1/apps/abc/install/stream"  // SSE URL
  title="Installing LibreChat"                   // header
  onComplete={() => {}}                          // called on success
  onError={(err) => {}}                          // called on failure
  patternMap={customPatterns}                    // optional output pattern overrides
/>
```

### 1c. Create `outputPatterns.js` utility
**File:** `server/frontend/src/utils/outputPatterns.js`

Pattern-to-friendly-message mapper:
```js
const DEFAULT_PATTERNS = [
  { match: /docker compose pull/i, message: "Downloading application files..." },
  { match: /docker compose up/i, message: "Starting application..." },
  { match: /system-setup/i, message: "Configuring application..." },
  { match: /created network/i, message: "Setting up networking..." },
  { match: /pulling/i, message: "Downloading images..." },
  // ... more patterns as needed
];
```

Each app's `app.yaml` could optionally define custom patterns, or we start with defaults and expand based on real output.

---

## Phase 2: Action Streaming (Frontend only)

### 2a. Update `ActionOptionsModal.jsx`
**Current flow:** POST to execute → wait → show `ActionResultModal` with complete result
**New flow:** POST to execute → if `stream_url` in response → show `ProgressFeedback` → on complete → show `ActionResultModal`

Changes:
- Check for `stream_url` in `ExecuteActionResponse`
- If present: show `ProgressFeedback` with stream URL
- On completion: transition to `ActionResultModal` (preserving existing behavior)
- If absent: fallback to current synchronous display with spinner
- Pass options as query params to the stream URL

### 2b. Backend: Allow options in stream endpoint
**File:** `server/backend/internal/api/handlers/scripts.go`

- `StreamAction` currently passes `nil` options to `StreamExecute`
- Parse options from query parameters (`?opt_name=value`)
- Pass to `executor.StreamExecute()`

---

## Phase 3: Install Streaming (Backend + Frontend)

### 3a. Backend: Add install output store to `Installer`
**File:** `server/backend/internal/apps/installer.go`

- Add `installOutputs map[string]chan ScriptOutput` to `Installer` struct
- `GetInstallOutputChannel(instanceID) <-chan ScriptOutput` — returns channel for an active install
- `completeInstall` writes docker compose + setup script output to this channel
- Channel is cleaned up when install finishes

### 3b. Backend: Capture `completeInstall` output
**File:** `server/backend/internal/apps/installer.go`

Modify `completeInstall` to:
- Create output channel in `installOutputs` at start
- Write progress events: `{type: "stdout", content: "Pulling images...\n"}` before each phase
- Pipe `StreamExecute` output (for setup script) into the channel
- Write `{type: "complete", exit_code: 0}` at end (or `{type: "error"}` on failure)
- Clean up channel in defer

### 3c. Backend: Add SSE endpoint for install stream
**File:** `server/backend/internal/api/handlers/scripts.go`

New handler: `StreamInstall(w, r)`:
- Route: `GET /api/v1/apps/{instanceId}/install/stream`
- Gets output channel from installer
- Streams events as SSE (`text/event-stream`)
- Ends when channel closes (install complete or failed)

**File:** `server/backend/internal/api/router.go`
- Add route: `r.Get("/{instanceId}/install/stream", scriptsHandler.StreamInstall)`

### 3d. Frontend: Update `ProgressStep.jsx`
**Current:** Polls `/apps/{id}/status` every 2s, shows fake `INSTALL_PHASES`
**New:** Uses `ProgressFeedback` component with real stream

Changes:
- Remove fake `INSTALL_PHASES` list entirely
- Render `ProgressFeedback` with stream URL `/api/v1/apps/{instanceId}/install/stream`
- Show app name as title: "Installing {appName}"
- `onComplete` calls parent's `onComplete()` callback
- `onError` shows retry option
- Keep status polling as fallback (reduced 10s frequency) in case SSE connection fails

### 3e. Frontend: Update `InstallWizard.jsx`
- No changes needed — `ProgressStep` handles streaming internally via `ProgressFeedback`

---

## Files Modified

| File | Change |
|------|--------|
| `server/frontend/src/hooks/useScriptStream.jsx` | **New** — SSE client hook |
| `server/frontend/src/components/common/ProgressFeedback.jsx` | **New** — friendly progress component |
| `server/frontend/src/utils/outputPatterns.js` | **New** — raw output → friendly message mapper |
| `server/frontend/src/components/app/actions/ActionOptionsModal.jsx` | Add streaming support |
| `server/frontend/src/components/app/wizard/ProgressStep.jsx` | Replace fake phases with real output |
| `server/backend/internal/api/handlers/scripts.go` | Add `StreamInstall` handler, pass options in `StreamAction` |
| `server/backend/internal/api/router.go` | Add install stream route |
| `server/backend/internal/apps/installer.go` | Add output channel, capture `completeInstall` output |

## Verification

1. `cd server/backend && make lint` — backend compiles and passes vet/fmt
2. `cd server/frontend && npm run lint` — frontend lints clean
3. Manual: Start an app install → ProgressStep shows friendly status by default, expandable to raw output
4. Manual: Run an action with `stream_output: true` → friendly progress during execution, result modal on complete
