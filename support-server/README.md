# Support Server (Cases + Chat Stub)

Lightweight backend to track support cases and messages. Intended to be paired with the relay and a future UI for agents.

## Run

```bash
cd support-server
go run ./cmd/server
```

Environment:
- `SUPPORT_SERVER_ADDR` – listen address (default `:8085`)
- `SUPPORT_ADMIN_TOKEN` – bearer token for agent/admin requests (optional)
- `SUPPORT_DEVICE_TOKEN` – bearer token for device/user requests (optional)

Auth header: `Authorization: Bearer <token>` and `X-Client-Role: admin|device`.

Endpoints:
- `GET /healthz`
- `POST /api/cases` (device/admin) `{device_id, summary, session_code?, contact?, scopes?}`
- `GET /api/cases` (admin)
- `GET /api/cases/{id}`
- `POST /api/cases/{id}/messages` `{author:"user|agent", text}`
- `POST /api/cases/{id}/status` `{status}`
- `POST /api/cases/{id}/scopes` `{scopes:[]}`

Data is in-memory (no persistence) to keep the stub simple; hook up a real store later.
