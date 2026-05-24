# Support Server (Cases + Subscriptions + AI Agent Persistence)

Lightweight backend that tracks support cases, manages subscriptions, and persists credit usage for LibreServ's AI support agent system.

## Run

```bash
cd support-server
go run ./cmd/server
```

Environment:
- `SUPPORT_SERVER_ADDR` – listen address (default `:8085`)
- `SUPPORT_ADMIN_TOKEN` – bearer token for admin requests (optional)
- `SUPPORT_DEVICE_TOKEN` – bearer token for device/user requests (optional)
- `SUPPORT_DB_PATH` – SQLite database path (default `support-server.db`)
- `SUPPORT_INSECURE_DEV` – set to `true` to allow running without auth tokens

Auth header: `Authorization: Bearer <token>` and `X-Client-Role: admin|device`.

## Endpoints

### Cases (legacy human support)

- `GET /healthz`
- `POST /api/cases` `{device_id, summary, session_code?, contact?, scopes?}`
- `GET /api/cases`
- `GET /api/cases/{id}`
- `POST /api/cases/{id}/messages` `{author, text}`
- `POST /api/cases/{id}/status` `{status}`
- `POST /api/cases/{id}/scopes` `{scopes}`

### Subscriptions (AI agent support)

- `GET /api/subscriptions?device_id=<id>` – Get device subscription, plan, and credit usage
- `POST /api/subscriptions` `{device_id, plan_id, server_token}` – Link device to a plan
- `POST /api/subscriptions/credits` `{device_id, conversation_id, model, input_tokens, output_tokens, cost_usd}` – Report credit usage
- `GET /api/plans` – List available plans

### Default Plans

| Plan | Price | Monthly Credit | Human Escalation | Self-Healing |
|------|-------|---------------|-----------------|-------------|
| Free | $0 | $5 | No | Yes |
| Basic | $15 | $10 | No | Yes |
| Premium | $25 | $20 | Yes | Yes |

Data is persisted in SQLite with WAL mode.
