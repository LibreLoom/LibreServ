# Plan: Frontend App Actions UI

## Context

The backend has full support for custom app actions with options (`internal/api/handlers/scripts.go`), but the frontend (`AppDetailPage.jsx`) only exposes Start/Stop/Restart/Update built-in operations. Custom actions (like `view-logs`) are not surfaced.

**Goal:** Add UI to discover, configure, and execute custom app script actions.

---

## Design

### UX Flow

1. **Actions Section** appears below "Control" section on `AppDetailPage`
2. User sees list of available actions as cards
3. Clicking an action:
   - If no options → Execute directly
   - If options → Open modal with option form
   - If `confirm.enabled` → Show confirmation dialog first
4. During execution → Show loading state
5. After execution → Show result toast or inline output

### API Integration

| Endpoint | Usage |
|----------|-------|
| `GET /apps/{instanceId}/actions` | List available actions |
| `GET /apps/{instanceId}/actions/{actionName}` | Get action schema (unused - list includes full schema) |
| `POST /apps/{instanceId}/actions/{actionName}/execute` | Execute with options |
| `GET /apps/{instanceId}/actions/{actionName}/stream` | SSE stream for long output |

### Key Insight: Reuse ConfigFieldRenderer

`ScriptOption` and `ConfigField` have identical structure:

```go
// ScriptOption (types.go:320)
Name, Label, Description, Type, Default, Required, Options, Validation, Min, Max, Secret

// ConfigField (types.go:160)  
Name, Label, Description, Type, Default, Required, Options, Validation, EnvVar
```

`ConfigFieldRenderer.jsx` can render both with minimal adaptation.

---

## Component Structure

```
AppDetailPage.jsx
├── [existing Control section]
└── [NEW] ActionsSection.jsx
    ├── ActionCard.jsx        # Single action button with metadata
    ├── ActionOptionsModal.jsx # Modal form for action options
    ├── ActionConfirmModal.jsx  # Confirmation for destructive actions
    └── ActionResultModal.jsx  # Show execution output/results
```

### ActionCard

Displays individual action with:
- Icon (from `action.icon` or default)
- Label and description
- "Requires options" badge if applicable
- Disabled state during execution

### ActionOptionsModal

- Reuses `ConfigFieldRenderer` for each option
- Handles form state with `useState`
- Validates required fields before submit
- Calls execute API
- Supports streaming if `action.execution.stream_output`

### ActionResultModal

Shows after execution completes:
- Success/failure status
- Script output (stdout)
- Error message (stderr)
- Duration
- Exit code

---

## Implementation Steps

### Step 1: Create ActionCard Component

**File:** `src/components/app/actions/ActionCard.jsx`

```jsx
export function ActionCard({ action, onExecute, disabled }) {
  const hasOptions = action.options?.length > 0;
  
  return (
    <div className="flex items-center justify-between p-4 border border-secondary/20 rounded-large-element">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-secondary/10 rounded-full">
          <WrenchIcon className="text-accent" size={20} />
        </div>
        <div>
          <p className="font-mono font-medium">{action.label}</p>
          {action.description && (
            <p className="text-sm text-primary/60">{action.description}</p>
          )}
          {hasOptions && (
            <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-pill">
              Has options
            </span>
          )}
        </div>
      </div>
      <button
        onClick={() => onExecute(action)}
        disabled={disabled}
        className="px-4 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/80 disabled:opacity-50"
      >
        Run
      </button>
    </div>
  );
}
```

### Step 2: Create ActionOptionsModal Component

**File:** `src/components/app/actions/ActionOptionsModal.jsx`

- Reuses `ConfigFieldRenderer` for each option
- Handles form state with `useState`
- Validates required fields before submit
- Calls execute API
- Supports streaming via EventSource

```jsx
export function ActionOptionsModal({ action, instanceId, onClose }) {
  const { request } = useAuth();
  const [options, setOptions] = useState({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  
  // ... form handling, validation, execution logic
  
  return (
    <ModalCard title={action.label} onClose={onClose}>
      {/* Option fields using ConfigFieldRenderer */}
      {/* Execute button */}
      {/* Result display */}
    </ModalCard>
  );
}
```

### Step 3: Create Confirmation Modal (Optional Enhancement)

For actions with `action.confirm.enabled = true`:

```jsx
<ActionConfirmModal 
  action={action}
  onConfirm={() => executeAction(action, {})}
  onCancel={onClose}
/>
```

### Step 4: Update AppDetailPage

**File:** `src/pages/AppDetailPage.jsx`

Add actions section after Control section:

```jsx
const [actions, setActions] = useState([]);
const [selectedAction, setSelectedAction] = useState(null);
const [showActionModal, setShowActionModal] = useState(false);

useEffect(() => {
  // Fetch actions when app loads
  const fetchActions = async () => {
    try {
      const res = await request(`/apps/${instanceId}/actions`);
      const data = await res.json();
      setActions(data.actions || []);
    } catch (err) {
      // Actions not available - app may not have any
      setActions([]);
    }
  };
  if (instanceId) fetchActions();
}, [instanceId, request]);

const handleActionExecute = (action) => {
  if (action.options?.length > 0) {
    setSelectedAction(action);
    setShowActionModal(true);
  } else {
    executeActionDirectly(action);
  }
};
```

Add section to render:

```jsx
{actions.length > 0 && (
  <section className="mb-8">
    <Card>
      <h2 className="text-2xl font-mono mb-4">Actions</h2>
      <div className="space-y-3">
        {actions.map(action => (
          <ActionCard 
            key={action.name}
            action={action}
            onExecute={handleActionExecute}
            disabled={actionLoading}
          />
        ))}
      </div>
    </Card>
  </section>
)}
```

### Step 5: Handle Streaming Output (Phase 2)

For actions with `execution.stream_output = true`, modify `ActionOptionsModal`:

```jsx
useEffect(() => {
  if (!action.execution?.stream_output) return;
  
  const eventSource = new EventSource(
    `/api/v1/apps/${instanceId}/actions/${action.name}/stream`
  );
  
  eventSource.onmessage = (event) => {
    const output = JSON.parse(event.data);
    // Append to output state
  };
  
  eventSource.onerror = () => {
    eventSource.close();
  };
  
  return () => eventSource.close();
}, [action, instanceId]);
```

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `src/components/app/actions/ActionCard.jsx` | Single action display |
| `src/components/app/actions/ActionOptionsModal.jsx` | Options form + execution |

### Modified Files
| File | Changes |
|------|---------|
| `src/pages/AppDetailPage.jsx` | Fetch actions, render ActionsSection |
| `src/components/app/wizard/ConfigFieldRenderer.jsx` | Export for reuse |
| `AppDetailPage.jsx` imports | Add Wrench/PlayIcon, ModalCard |

### Optional: If Confirmation Needed
| File | Purpose |
|------|---------|
| `src/components/app/actions/ActionConfirmModal.jsx` | Destructive action confirmation |

---

## Edge Cases & Error Handling

1. **No actions available** - Don't render section at all
2. **Action execution fails** - Show error in result modal with stderr output
3. **Network error during execution** - Show error toast, allow retry
4. **Script timeout** - Backend should handle, show timeout error
5. **Action disabled during execution** - Prevent concurrent executions
6. **App not found** - 404 handled, redirect to apps list

---

## UI Mockup

```
┌─────────────────────────────────────────────────────────────┐
│ Control                                                     │
│ [Start] [Stop] [Restart]                    [Uninstall]    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Actions                                          [≡ More]  │
├─────────────────────────────────────────────────────────────┤
│ 🔧  View Logs                                    [Run]     │
│     View MotionEye application logs                         │
│                                                              │
│ 🔄  Reset Camera                          [Run]     │
│     Restart a specific camera                              │
│     ⚠️ Has options                                           │
└─────────────────────────────────────────────────────────────┘

When "Reset Camera" is clicked:
┌─────────────────────────────────────────────────────────────┐
│ Reset Camera                                          [X]  │
├─────────────────────────────────────────────────────────────┤
│ Camera ID *                                                │
│ [ Select camera...                                    ▾ ]  │
│                                                              │
│ [ Run ]                              [ Cancel ]             │
└─────────────────────────────────────────────────────────────┘

After execution:
┌─────────────────────────────────────────────────────────────┐
│ ✓ Action Completed                                    [X]  │
├─────────────────────────────────────────────────────────────┤
│ Exit code: 0                                    Duration: 2s │
│                                                              │
│ Output:                                                      │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Camera reset successfully                               │ │
│ │ Watching for motion...                                  │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│                                                    [ Close ]│
└─────────────────────────────────────────────────────────────┘
```

---

## Testing Considerations

1. Mock API responses for apps with various action configurations
2. Test actions with no options (direct execution)
3. Test actions with various option types (string, select, boolean)
4. Test confirmation dialog flow for destructive actions
5. Test streaming output display
6. Test error states (script failure, network error)

---

## Dependencies

- `ConfigFieldRenderer` - Already exists, just need to export it
- `ModalCard` - Already exists in `src/components/common/cards/ModalCard.jsx`
- `Card` - Already exists
- `useAuth` hook - Already available
- Icons from `lucide-react`

---

## Alternative Designs Considered

**1. Integrate into Control Section**
- Pro: Less screen space
- Con: Mixed concerns, harder to find actions

**2. Dropdown Menu for Actions**
- Pro: Compact
- Con: Hides options, poor UX for frequent actions

**3. Tabbed Interface (Control | Actions)**
- Pro: Clean separation
- Con: Extra click to switch tabs

**Chosen:** Separate "Actions" section with cards - best visibility and discoverability.
