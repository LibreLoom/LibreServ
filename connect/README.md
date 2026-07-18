# LibreServ Connect

Cloud SaaS companion for LibreServ home servers. Provides external services:
email relay, domain & DNS, cloud backup storage, tunnel access, AI inference,
and human support.

## Run

```bash
cd connect
cp configs/connect.yaml.example configs/connect.yaml
make run
```

## Environment

- `CONNECT_CONFIG` — path to config YAML
- `CONNECT_ADMIN_TOKEN` — bearer token for admin requests
- `CONNECT_SERVER_PORT` — listen port (default 8080)

## Device API

- `POST /api/v1/activate` — Activate with token
- `POST /api/v1/deactivate` — Deactivate device
- `GET /api/v1/status` — Current status & services
- `GET /api/v1/usage` — Usage summary
- `GET /api/v1/info` — Plan catalog
- `POST /api/v1/services/provision` — Provision service credentials

## Admin API

Requires `Authorization: Bearer $CONNECT_ADMIN_TOKEN`.

- `GET /admin/devices`
- `GET /admin/devices/{deviceID}`
- `POST /admin/devices/{deviceID}/credentials/rotate`
- `GET /admin/cases`
- `POST /admin/cases/{caseID}/messages`
- `POST /admin/cases/{caseID}/consent-requests`
- `GET /admin/plans`
- `PUT /admin/plans/{planID}`

## Support API

- `GET /api/v1/cases`
- `POST /api/v1/cases`

## Billing

- Polar integration enabled by config (Merchant of Record — handles global tax)
- Crypto wallet billing deferred (manual reconciliation)

## Permission / Consent Model

- Secretless configs are visible to support staff by default
- User data files require **explicit per-file consent**
- Credentials are **never readable** by staff — only rotatable
- Consent requests expire after 24 hours
