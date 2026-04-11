# Plan: Settings Page UX Revamp

## Context

The Settings page has 5 categories (General, Appearance, Backups, Security, About) with significant UX problems: no loading states, inconsistent components, duplicate code, missing backend API integrations, and a critical security bug in the backend.

**Prerequisite:** Phase A (shared components + ui/ cleanup) is COMPLETE. All shared components built, duplicates deleted, backend security bug fixed.

---

## Completed Work (Phase A + Phase 0.1)

### A1: Delete ui/ duplicates (DONE)
Deleted 6 files from `ui/`: Dropdown.jsx, RefreshDropdown.jsx, ErrorDisplay.jsx, StatusPill.jsx, AppIcon.jsx, LoadingBar.jsx. Redirected 9 import sites to `common/`.

### A2: Build shared components (DONE)
Created 11 new components:
- `forms/Toggle.jsx` — role=switch, aria-checked, M3 motion, focus-visible
- `forms/Select.jsx` — styled native select, ChevronDown, pill-shaped
- `forms/RadioGroup.jsx` — custom radios with sr-only inputs, peer-focus-visible ring
- `forms/CheckboxGroup.jsx` — custom checkboxes, peer-focus-visible ring
- `forms/ColorInput.jsx` — color picker + hex text, 3/6 digit hex validation, ref-based external sync
- `forms/PasswordStrengthIndicator.jsx` — 5-bar strength meter, role=status, aria-live
- `settings/SettingsCard.jsx` — icon+title header, useAnimatedHeight, memo()
- `settings/ValueDisplay.jsx` — label-value row, font-mono
- `settings/ExtraInfoSection.jsx` — collapsible chevron, max-h-96 for animation
- `common/EmptyState.jsx` — icon+title+description+action
- `common/StatusBadge.jsx` — pill badge, 6 color variants

### A3: Extract shared utilities (DONE)
- PasswordStrengthIndicator extracted from AddUserForm → `forms/`
- StatusBadge extracted from GeneralCategory → `common/`

### Phase 0.1: Backend security events SQL fix (DONE)
Fixed `ListEvents` in `server/backend/internal/security/service.go`:
- Added dynamic WHERE clause from EventFilter fields (ActorID, EventType, Severity, Since)
- Non-admin users now isolated to their own events

### Bug Fixes Applied (DONE)
- StatusPill unknown nested var() CSS fix
- AppearanceCategory ColorInput stale text on preset selection
- SettingsPage error stuck without dismiss/retry
- Logging dropdown interactive before load
- performSave losing data on API failure
- RadioGroup name collision across instances
- AddUserForm: focus-visible, border-error, PropTypes, indentation

### Permission Fixes (DONE - separate commit)
- PUID/PGID injection in installer.go
- App compose templates updated with user: directives
- Dockerfile non-root user
- RunCustomAppSafely user injection

---

## Remaining Work

### Phase 0 (Backend Fixes) — Partially Done

#### 0.2 Add persist flag to `PUT /api/v1/settings` (TODO)

**File:** `server/backend/internal/api/handlers/settings.go`

Current `Update` handler only modifies in-memory config. Add `Persist bool` and `FilePath string` to the request body (matching notify handler pattern). When `persist: true`, call `config.SaveConfig(req.FilePath)`.

**Design decision:** Default `persist` to `true` (opposite of notify handler which defaults to false). Rationale: a user changing their logging level in the UI expects it to stick.

#### 0.3 Fix YAML struct tags on SMTPConfig/Notifications (TODO)

**File:** `server/backend/internal/config/config.go`

The `SMTPConfig` and `Notifications` structs have `mapstructure` tags but no `yaml` tags. When `SaveConfig()` calls `yaml.Marshal`, Go's default YAML key names may not match Viper's `mapstructure` binding on reload.

**Fix:** Add explicit `yaml:` tags to every field matching the `mapstructure:` key names.

---

### Phase B: Rebuild SettingsPage Shell (~2-3 hours)

**File:** `server/frontend/src/pages/SettingsPage.jsx`

#### Changes

1. **Add loading state:** Show skeleton cards while `settings` and `securitySettings` are null. Use existing `TypewriterLoader` or build a `SettingsSkeleton` component.

2. **Add error + retry:** Replace static `<ErrorDisplay>` with error banner + retry button that re-calls `fetchSettings()`. (PARTIALLY DONE — dismiss/retry added, but no skeleton loading state)

3. **Add save indicator:** Small persistent status in the content header:
   - "Saving..." (yellow dot, shown during debounce)
   - "Saved" (green dot, shown for 3s after successful save)
   - "Unsaved changes" (amber dot, shown when local state differs from server)
   - Use `useRef` to track last-saved state, compare on every change.

4. **Remove `key={category}` remount:** In `SettingsContent.jsx`, remove the `key={category}` prop that forces full remount on every category switch. Instead, use CSS show/hide or a more granular key that doesn't reset state.

5. **Replace `h-[calc(100vh-4rem)]`:** Use a CSS variable `--navbar-height` or measure dynamically.

6. **New category order:**
   - System (replaces General + About)
   - Notifications (NEW — SMTP + notification prefs)
   - Appearance (refactored)
   - Backups (refactored)
   - Security (slimmed)

#### SettingsSidebar.jsx changes
- Update category list to new 5 categories
- Add keyboard navigation (tablist/tab pattern with arrow keys)
- Use `font-normal` instead of `font-bold` on inactive labels
- Remove animation delay computation from render

#### SettingsContent.jsx changes
- Update `getSettingsProps()` to pass notify config to Notifications category
- Add notify config API client functions to `lib/notify-api.js`

---

### Phase C: Rebuild Categories (~6-8 hours)

#### C1: System Category (~1.5 hours)

**New file:** `server/frontend/src/components/settings/categories/SystemCategory.jsx`
**Deletes:** `GeneralCategory.jsx`, `AboutCategory.jsx`

Merges General + About into one category with:

- **Logging card** (using `SettingsCard`):
  - Log level select (shared `Select` component)
  - Persist checkbox ("Save across restarts")
  - Log path display (read-only `ValueDisplay`)

- **Server Info card** (using `SettingsCard`):
  - Host, port, mode, proxy type as `ValueDisplay` rows
  - Collapsible "Advanced" section with proxy details (using shared `ExtraInfoSection`)

- **About card** (using `SettingsCard`):
  - Version from API or build-time variable (NOT hardcoded)
  - Links to: docs, source repo (gitea), license, Ko-fi
  - Short description

**Backend change needed:** Add version endpoint or embed version in `GET /settings` response.

#### C2: Notifications Category (~2 hours)

**New file:** `server/frontend/src/components/settings/categories/NotificationsCategory.jsx`
**New file:** `server/frontend/src/lib/notify-api.js`

This is a NEW category wiring up the existing `/api/v1/notify/config` backend.

- **SMTP Configuration card** (using `SettingsCard`):
  - Host, port (shared `FormInput`)
  - Username, password (shared `FormInput` with password toggle)
  - From address (shared `FormInput`)
  - TLS toggle (shared `Toggle`)
  - Skip certificate verification toggle (shared `Toggle`) — with warning badge
  - "Save & Test" button — persists config then sends test email
  - "Save Only" button — persists without test

- **Notification Preferences card** (using `SettingsCard`):
  - Enable notifications toggle (shared `Toggle`) — moved from SecurityCategory
  - Frequency selector (shared `RadioGroup`): instant / normal / digest
  - Event type checkboxes (shared `CheckboxGroup`): login, failed login, password change, admin action

- **Test Notification card**:
  - Send test email button with feedback
  - Status display: "Test email sent to user@example.com"

**API client functions needed:**
```js
// notify-api.js
export async function getNotifyConfig(request)
export async function updateNotifyConfig(request, { smtp, notify, persist, filePath })
export async function previewTemplate(request, { template, data })
```

#### C3: Appearance Category (~1.5 hours)

**Refactor:** `server/frontend/src/components/settings/categories/AppearanceCategory.jsx`

Same functionality, rebuilt with shared components:

- Replace inline toggle with shared `Toggle`
- Replace local `ColorInput` with shared `ColorInput`
- Fix hex validation to accept 3-digit shorthand (`#fff` → `#ffffff` conversion) (DONE in shared ColorInput)
- Replace `max-h-[2000px]` and `max-h-[500px]` with `useAnimatedHeight`
- Add confirmation dialog before reset ("Reset all colors to default?")
- Add `font-sans` to labels instead of `font-mono`

#### C4: Backups Category (~2 hours)

**Refactor + split:** `server/frontend/src/components/settings/categories/BackupsCategory.jsx`

Split the 909-line monolith into sub-components:

- `server/frontend/src/components/backups/LocalBackups.jsx` — backup list, create, delete
- `server/frontend/src/components/backups/CloudBackupSection.jsx` — cloud config, upload
- `server/frontend/src/components/backups/BackupSchedule.jsx` — schedule form
- `server/frontend/src/components/backups/DatabaseBackup.jsx` — save/restore database
- `server/frontend/src/components/backups/BackupModals.jsx` — shared modal components

**Fixes:**
- Add `bg-black/50` backdrop to all modals
- Fix Escape key handling — use `autoFocus` or focus trap instead of `tabIndex={-1}`
- Add confirmation dialog for database restore (use `VerificationCard`)
- Replace raw `fetch()` with `request()` from `useAuth`
- Fix Upload/Restore icon collision — use `RotateCcw` for restore, `Upload` for upload
- Add "Show All" button for truncated backup list
- Replace `rounded-[16px]` with `rounded-large-element`
- Replace native `<select>` with shared `Select` component
- Remove duplicate "Configure Cloud Backup" CTAs (keep one)

#### C5: Security Category (~1.5 hours)

**Refactor:** `server/frontend/src/components/settings/categories/SecurityCategory.jsx`

Slimmed down after moving notification prefs to Notifications category:

- **Activity Log card** (using `SettingsCard`):
  - Stat cards row (4 cards — keep existing but fix label colors for consistency)
  - Filter bar with shared `Select` for event type and severity (filters now work after Phase 0.1)
  - Table with pagination or virtualization (not `max-h-64` fixed height)
  - Table caption for a11y

- **Security Overview card** (using `SettingsCard`):
  - Show actual security posture (not fake hardcoded values)
  - "Test notification" button (calls `/security/test-notification`)
  - Contextual tips: highlight tips based on actual settings state

**Remove:**
- Fake "Account Lockout: Enabled" display
- Fake "Password Requirements: 12+ chars..." display
- Notification preferences (moved to Notifications category)
- Notification frequency radio buttons (moved)
- Security tips static grid (replaced with contextual version)

---

### Phase D: Polish (~1-2 hours)

#### Cross-cutting fixes

- Replace ALL remaining `max-h-[NNNpx]` with `useAnimatedHeight` across all categories
- Standardize border radius:
  - `rounded-large-element` (24px) for card containers
  - `rounded-pill` (9999px) for inputs, buttons, badges
  - `rounded-card` (12px) for inner card elements
- Standardize `focus-visible:` everywhere (replace all `focus:` on interactive elements)
- Add `aria-label` to all selects, buttons without visible text
- Add `id`/`htmlFor` linkage in `SettingsRow` component
- Add focus traps to all modals (use `ModalCard` which already has this)
- Add table captions for activity log
- Replace spacer `<div>` elements with proper padding/margin
- Add `font-sans` to all body text, reserve `font-mono` for headings only

#### Testing
- Run `npm run lint` and fix all issues
- Run `npm test` and update any broken tests
- Manual test: mobile responsive on all categories
- Manual test: loading states, error states, save indicators

---

## Design Guidelines Reference

From [Simplex Mono](https://gt.plainskill.net/LibreLoom/libreloom-branding) and `index.css`:

| Element | Spec |
|---------|------|
| Card | `border: 2px solid secondary`, `rounded-large-element` (24px), `p-8`, flat (no shadow) |
| Button (primary) | `bg-secondary text-primary`, `rounded-pill`, `px-8 py-4`, hover: scale 1.05 |
| Button (outline) | transparent bg, `border: 2px solid secondary`, hover: fill with secondary |
| Input | `border: 2px solid secondary`, `rounded-pill`, `px-6 py-4`, focus: accent border + ring |
| Focus ring | `border-accent`, `box-shadow: 0 0 0 3px rgba(118,118,118,0.1)`, use `focus-visible:` |
| Headings | FreeMono (`font-mono`), `font-normal` weight |
| Body text | Noto Sans (`font-sans`), `font-normal` |
| Motion | 200-400ms, M3 easing tokens in index.css |
| Padding | Cards: 32px (`p-8`), Between fields: 24px, Label→input: 8px |

---

## Deferred Items

- **Network category** → Phase 3 roadmap task (T3.1.1-T3.1.3)
- **Account category** → dropped; UsersPage sufficient for MVP
- **Self-service email change** → needs new `PUT /auth/me/email` backend endpoint
- **Role-based access control** → Phase 5.1 (post-MVP)
- **Admin role check on `PUT /settings`** → can add during Phase 0.2
- **Config reload mechanism** → nice-to-have, not blocking
- **Notification template preview UI** → stretch goal for C2
