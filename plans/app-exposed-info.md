# Plan: App-Exposed Information System

## Context

Apps like LibreChat, Ollama, Nextcloud, etc. generate critical credentials during installation:
- Auto-generated passwords
- API keys
- JWT secrets
- Database credentials
- Default usernames

Currently, this information is:
- Stored in `config.json` on the filesystem
- Passed to scripts via `config.json`
- **NOT exposed to users via the frontend**

This creates problems:
- Users can't retrieve auto-generated passwords
- No visibility into app connection details
- Script output data isn't surfaced

## Goals

1. Allow apps to declare which config fields should be **exposed to the frontend**
2. Allow scripts to **output structured data** (e.g., default credentials, connection URLs)
3. Provide a **dedicated UI section** on AppDetailPage to display this info
4. Maintain **security** by not exposing sensitive data to unauthorized users

---

## Design

### 1. App Definition - Exposed Config (`app.yaml`)

```yaml
exposed_info:
  - name: jwt_secret
    label: "JWT Secret"
    description: "Secret key for JWT tokens"
    type: password        # password | string | url | username
    copyable: true       # allow copy button
    revealable: true     # allow show/hide toggle
    mask_by_default: true
  - name: meili_master_key
    label: "Meilisearch Master Key"
    type: password
    copyable: true
  - name: default_username
    label: "Default Username"
    type: username
    default: "admin"
  - name: external_url
    label: "External URL"
    type: url
    description: "Public URL for accessing this app"
```

### 2. Script Output Schema

Scripts can output JSON with an `exposed_info` key:

```json
{
  "exposed_info": {
    "admin_password": "auto-generated-password",
    "connection_url": "https://app.libreserv.local",
    "api_endpoint": "http://localhost:8080"
  }
}
```

The `ScriptResult.Data.exposed_info` field will be used by the frontend.

### 3. Backend Types

**`internal/apps/types.go`** - Add to `AppDefinition`:

```go
type ExposedInfoField struct {
    Name        string `yaml:"name" json:"name"`
    Label       string `yaml:"label" json:"label"`
    Description string `yaml:"description,omitempty" json:"description,omitempty"`
    Type        string `yaml:"type" json:"type"` // password, string, url, username
    Copyable    bool   `yaml:"copyable" json:"copyable"`
    Revealable  bool   `yaml:"revealable" json:"revealable"`
    MaskByDefault bool  `yaml:"mask_by_default" json:"mask_by_default"`
}

type AppDefinition struct {
    // ... existing fields
    ExposedInfo []ExposedInfoField `yaml:"exposed_info,omitempty" json:"exposed_info,omitempty"`
}
```

**`internal/apps/types.go`** - Modify `InstalledApp`:

```go
type InstalledApp struct {
    // ... existing fields
    ExposedInfo map[string]interface{} `json:"exposed_info,omitempty"` // Merged from app.yaml + script output
}
```

### 4. API Changes

**`GET /apps/{instanceId}`** - Response includes `exposed_info` merged from:
1. App definition's `exposed_info` config fields
2. Script output's `exposed_info` data

```go
type ExposedInfoValue struct {
    Label         string      `json:"label"`
    Description   string      `json:"description,omitempty"`
    Type          string      `json:"type"` // password, string, url, username
    Value         interface{} `json:"value,omitempty"`
    Copyable      bool        `json:"copyable"`
    Revealable    bool        `json:"revealable"`
    MaskByDefault bool        `json:"mask_by_default"`
}
```

**New endpoint: `GET /apps/{instanceId}/exposed-info/{fieldName}`**
- For lazy-loading sensitive values (optional optimization)

### 5. ScriptExecutor Changes

**`internal/apps/script_executor.go`**:

```go
func (e *ScriptExecutor) Execute(...) (*ScriptResult, error) {
    // ... existing logic ...
    
    // After script execution, parse exposed_info from output
    data := e.parseScriptOutput(output)
    if data != nil {
        result.Data = data
        // Check for exposed_info in script output
        if exposedInfo, ok := data["exposed_info"].(map[string]interface{}); ok {
            result.ExposedInfo = exposedInfo
        }
    }
    return result, nil
}
```

### 6. Manager Changes

**`internal/apps/manager.go`** - Merge exposed info:

```go
func (m *Manager) GetInstalledApp(ctx context.Context, instanceID string) (*InstalledApp, error) {
    app, err := m.getInstalledAppFromDB(ctx, instanceID)
    if err != nil {
        return nil, err
    }
    
    // Merge exposed_info from app definition
    app.ExposedInfo = m.mergeExposedInfo(app, catalogApp)
    
    return app, nil
}

func (m *Manager) mergeExposedInfo(app *InstalledApp, catalogApp *AppDefinition) map[string]interface{} {
    merged := make(map[string]interface{})
    
    // Start with config values for exposed fields
    for _, field := range catalogApp.ExposedInfo {
        if val, ok := app.Config[field.Name]; ok {
            merged[field.Name] = map[string]interface{}{
                "label":          field.Label,
                "description":    field.Description,
                "type":           field.Type,
                "value":          val,
                "copyable":       field.Copyable,
                "revealable":     field.Revealable,
                "mask_by_default": field.MaskByDefault,
            }
        }
    }
    
    return merged
}
```

---

## Frontend Implementation

### 1. New Component: `ExposedInfoCard.jsx`

```jsx
// server/frontend/src/components/app/ExposedInfoCard.jsx

export function ExposedInfoCard({ info }) {
  const [revealed, setRevealed] = useState({});
  const [copied, setCopied] = useState({});

  const toggleReveal = (key) => {
    setRevealed(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = async (key, value) => {
    await navigator.clipboard.writeText(String(value));
    setCopied(prev => ({ ...prev, [key]: true }));
    setTimeout(() => setCopied(prev => ({ ...prev, [key]: false })), 2000);
  };

  const renderValue = (field, key) => {
    const isRevealed = revealed[key];
    const shouldMask = field.mask_by_default && !isRevealed;
    
    if (field.type === 'url') {
      return (
        <a href={field.value} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          {field.value}
        </a>
      );
    }
    
    if (shouldMask) {
      return <span className="font-mono">••••••••</span>;
    }
    
    return <span className="font-mono">{String(field.value)}</span>;
  };

  return (
    <Card className="...">
      <h2 className="text-2xl font-mono mb-4">Connection Info</h2>
      <div className="space-y-4">
        {Object.entries(info).map(([key, field]) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">{field.label}</p>
              {field.description && (
                <p className="text-xs text-primary/60">{field.description}</p>
              )}
              <div className="mt-1">{renderValue(field, key)}</div>
            </div>
            <div className="flex gap-2">
              {field.revealable && (
                <button onClick={() => toggleReveal(key)} className="...">
                  {revealed[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              )}
              {field.copyable && (
                <button onClick={() => copyToClipboard(key, field.value)} className="...">
                  {copied[key] ? <Check size={16} /> : <Copy size={16} />}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

### 2. Update `AppDetailPage.jsx`

Add the `ExposedInfoCard` between Resource Usage and Control sections:

```jsx
{app.exposed_info && Object.keys(app.exposed_info).length > 0 && (
  <section className="mb-8">
    <ExposedInfoCard info={app.exposed_info} />
  </section>
)}
```

---

## Security Considerations

1. **Passwords stored hashed?** - No, we need the actual values for apps to use. This is acceptable since:
   - `config.json` is stored on the server filesystem with restricted permissions
   - API requires authentication
   - Users can already access container logs which may contain these values

2. **Authorization** - Only authenticated users with app access should see exposed info

3. **Audit logging** - Log when exposed info is accessed

4. **Script output validation** - Validate `exposed_info` structure in ScriptExecutor

---

## Implementation Steps

### Phase 1: Backend Core
1. Add `ExposedInfoField` and `ExposedInfo` types to `types.go`
2. Update `AppDefinition` to include `ExposedInfo`
3. Update `InstalledApp` to include `ExposedInfo` map
4. Update `Manager.mergeExposedInfo()` to build the merged map
5. Update `ScriptExecutor` to extract `exposed_info` from script output
6. Update `GET /apps/{instanceId}` handler to include `exposed_info`
7. Add migration if needed for database changes

### Phase 2: App Definitions
1. Add `exposed_info` to `librechat/app.yaml` as reference implementation
2. Document the schema in `docs/app_exposed_info.md`

### Phase 3: Frontend UI
1. Create `ExposedInfoCard.jsx` component
2. Add `Eye`, `EyeOff`, `Copy`, `Check` icons to imports
3. Update `AppDetailPage.jsx` to render `ExposedInfoCard`
4. Add styling (should fit existing Card component pattern)

### Phase 4: Polish
1. Add "copy to clipboard" feedback animation
2. Consider adding "reveal on hover" for sensitive fields
3. Add support for grouping info (e.g., "Credentials", "Connection Details")

---

## Files to Modify

### Backend
- `internal/apps/types.go` - Add ExposedInfo types
- `internal/apps/manager.go` - Add mergeExposedInfo method
- `internal/apps/script_executor.go` - Extract exposed_info from script output
- `internal/api/handlers/apps.go` - Include exposed_info in response
- `server/backend/apps/builtin/librechat/app.yaml` - Add exposed_info example

### Frontend
- `src/components/app/ExposedInfoCard.jsx` - New component
- `src/pages/AppDetailPage.jsx` - Render ExposedInfoCard

### Documentation
- `docs/app_exposed_info.md` - Document the feature for app developers

---

## Example: LibreChat Exposed Info

```yaml
# In librechat/app.yaml
exposed_info:
  - name: meili_master_key
    label: "Meilisearch Master Key"
    description: "Master key for search functionality"
    type: password
    copyable: true
    revealable: true
    mask_by_default: true
  - name: jwt_secret
    label: "JWT Secret"
    type: password
    copyable: true
    mask_by_default: true
  - name: external_url
    label: "Access URL"
    type: url
    copyable: true
```

Would render on AppDetailPage as:

```
┌─────────────────────────────────────────────┐
│ Connection Info                             │
├─────────────────────────────────────────────┤
│ Meilisearch Master Key                [👁] [📋]
│ Master key for search functionality          │
│ •••••••••••••••                              │
├─────────────────────────────────────────────┤
│ JWT Secret                            [👁] [📋]
│ •••••••••••••••                              │
├─────────────────────────────────────────────┤
│ Access URL                            [📋]  │
│ https://librechat.libreserv.local           │
└─────────────────────────────────────────────┘
```
