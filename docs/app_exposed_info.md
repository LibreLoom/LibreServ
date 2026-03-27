# App Exposed Info

This document describes how app developers can expose configuration values (like auto-generated passwords, API keys, and connection URLs) to users through the LibreServ frontend.

## Overview

Apps often generate critical credentials during installation:
- Auto-generated passwords
- API keys
- JWT secrets
- Database credentials
- Default usernames

The **Exposed Info** system allows apps to declare which configuration fields should be visible to users in the app detail page, with proper security controls like masking and copy-to-clipboard functionality.

## App Definition Schema

Add an `exposed_info` section to your `app.yaml`:

```yaml
exposed_info:
  - name: jwt_secret
    label: "JWT Secret"
    description: "Secret key for JWT tokens"
    type: password        # password | string | url | username
    copyable: true        # allow copy button
    revealable: true      # allow show/hide toggle
    mask_by_default: true # mask value by default
  - name: external_url
    label: "External URL"
    type: url
    description: "Public URL for accessing this app"
    copyable: true
```

### Field Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | The config field name to expose |
| `label` | string | Yes | Human-readable label shown in UI |
| `description` | string | No | Optional description text |
| `type` | string | Yes | One of: `password`, `string`, `url`, `username` |
| `copyable` | bool | No | Show copy-to-clipboard button (default: false) |
| `revealable` | bool | No | Show show/hide toggle for passwords (default: false) |
| `mask_by_default` | bool | No | Mask the value by default (default: false) |

### Field Types

- **`password`**: Sensitive credential, typically masked
- **`string`**: Generic text value
- **`url`**: Clickable URL that opens in new tab
- **`username`**: Username value, typically not masked

## Script Output Schema

Scripts can output dynamic values that get merged with the app definition. Output JSON with an `exposed_info` key:

```bash
#!/bin/bash
# system-setup script

# Generate credentials
ADMIN_PASSWORD=$(openssl rand -base64 32)
API_KEY=$(uuidgen)

# Store in config (for app runtime)
echo "{\"admin_password\": \"$ADMIN_PASSWORD\", \"api_key\": \"$API_KEY\"}" > "$CONFIG_PATH"

# Output exposed_info for frontend
cat <<EOF
{
  "exposed_info": {
    "admin_password": "$ADMIN_PASSWORD",
    "api_key": "$API_KEY"
  }
}
EOF
```

The script output's `exposed_info` values are merged with the app definition's `exposed_info` fields.

## How It Works

1. **App Definition**: The `exposed_info` section in `app.yaml` declares which fields to expose and how to display them.

2. **Script Output**: During installation, setup scripts can output an `exposed_info` object with dynamically generated values.

3. **API Response**: The `GET /api/apps/{instanceId}` endpoint returns an `exposed_info` object containing merged values with display metadata.

4. **Frontend Display**: The `ExposedInfoCard` component renders the exposed info with:
   - Masked values for passwords (with reveal toggle)
   - Copy-to-clipboard buttons
   - Clickable URLs
   - Descriptions and labels

## Example: LibreChat

```yaml
# librechat/app.yaml
exposed_info:
  - name: meili_master_key
    label: "Meilisearch Master Key"
    description: "Master key for Meilisearch search functionality"
    type: password
    copyable: true
    revealable: true
    mask_by_default: true
  - name: jwt_secret
    label: "JWT Secret"
    description: "Secret key for JWT token authentication"
    type: password
    copyable: true
    revealable: true
    mask_by_default: true
  - name: jwt_refresh_secret
    label: "JWT Refresh Secret"
    description: "Secret key for JWT refresh tokens"
    type: password
    copyable: true
    revealable: true
    mask_by_default: true
```

## API Response Format

The `GET /api/apps/{instanceId}` response includes:

```json
{
  "id": "librechat-abc123",
  "name": "LibreChat",
  "exposed_info": {
    "meili_master_key": {
      "label": "Meilisearch Master Key",
      "description": "Master key for Meilisearch search functionality",
      "type": "password",
      "value": "generated-key-value",
      "copyable": true,
      "revealable": true,
      "mask_by_default": true
    },
    "jwt_secret": {
      "label": "JWT Secret",
      "description": "Secret key for JWT token authentication",
      "type": "password",
      "value": "generated-jwt-secret",
      "copyable": true,
      "revealable": true,
      "mask_by_default": true
    }
  }
}
```

## Security Considerations

1. **Authentication Required**: Only authenticated users can access exposed info.

2. **Values Stored in Config**: Exposed values are stored in the app's `config.json` on the server filesystem with restricted permissions.

3. **Masking by Default**: Password-type fields are masked by default and require explicit user action to reveal.

4. **No Separate Storage**: Exposed info values are not stored separately; they reference existing config values.

## Best Practices

1. **Use `type: password`** for sensitive credentials like API keys, secrets, and passwords.

2. **Enable `mask_by_default: true`** for any field that could be sensitive.

3. **Add `description`** to help users understand what each credential is for.

4. **Enable `copyable: true`** for values users need to copy-paste elsewhere.

5. **Enable `revealable: true`** for passwords users need to see (like default admin passwords).

6. **Don't expose** values that are truly secret and should never be visible (like encryption keys that apps use internally).
