# Luna Connect mocks

Run these commands from `luna/` unless a path says otherwise.

## Standard mock

Start the mock in the background:

```bash
bash scripts/mocks/mock-connect.sh serve --daemon --mode unbound
```

Create a device token and a rolling credential, then pair and claim them
through the mock:

```bash
bash scripts/mocks/mock-connect.sh mint-device --write
```

That writes `dev/device-token` and `dev/connect-credential`. Secret files are
mode `0600`. The removed `mint-token` command is not used, and `device-token`
is the single pairing token, not the old permanent bearer.

For the usual paired development setup with an address and cloud backup:

```bash
bash scripts/mocks/seed-mock-connect.sh
```

The seed script checks that the local credential actually authenticates and
that the local device token matches the mock before reusing either. It replaces
stale local pairing material when the mock was unbound or recreated.

Inspect and control the mock:

```bash
bash scripts/mocks/mock-connect.sh status
bash scripts/mocks/mock-connect.sh status --json
bash scripts/mocks/mock-connect.sh mode set bound
bash scripts/mocks/mock-connect.sh mode set unbound
bash scripts/mocks/mock-connect.sh mode set challenge
bash scripts/mocks/mock-connect.sh domain set kitchen
bash scripts/mocks/mock-connect.sh backup unlock
bash scripts/mocks/mock-connect.sh backup lock
bash scripts/mocks/mock-connect.sh backup stats
bash scripts/mocks/mock-connect.sh backup clean
bash scripts/mocks/mock-connect.sh stop
```

`mode set bound` is a debug shortcut, not the pairing flow. If it replaces an
unbound mock's credential, run `mint-device --write` or `seed-mock-connect.sh`
again so the local credential is not stale.

Start lunad against the mock:

```bash
LUNA_CONNECT_URL=http://127.0.0.1:18765 make daemon-dev
```

## Storage contract

Storage requests use the rolling credential plus `X-Luna-Id`. For example:

```bash
curl -fsS http://127.0.0.1:18765/api/v1/storage/usage \
  -H "Authorization: Bearer $(tr -d '\r\n' < dev/connect-credential)" \
  -H 'X-Luna-Id: luna-development'
```

Packs are named by their lowercase SHA-256 hex digest, are limited to 64 MiB,
and are isolated by `X-Luna-Id`. Records are limited to 1 MiB. Record listings
support `limit`, `after`, `prefix`, `version`, and `total`; paged replies use
`names`, `total`, `next_after`, and `version`.

The default account quota is 2,000,000,000,000 bytes. Set a smaller quota for
development before starting the server:

```bash
LUNA_MOCK_QUOTA_BYTES=134217728 bash scripts/mocks/mock-connect.sh serve --daemon --mode unbound
```

A quota refusal is HTTP 507. Signing-public registration accepts the real
3968-hex-character Ed25519 + ML-DSA-65 hybrid public key.

## Cloudflare challenge and device-state mock

```bash
python3 scripts/mocks/mock-connect-cf-challenge.py
```

It uses `dev/connect-credential` and creates a missing `dev/device-token`. It
never logs the Authorization header. Switch between `challenge`, `bound`,
`bound_spawn`, `unbound`, `revoked`, and `401` with:

```bash
curl -fsS -X POST http://127.0.0.1:18765/_debug/mode \
  -H 'Content-Type: application/json' -d '{"mode":"revoked"}'
```

`unbound` and `revoked` return the real `device_unbound` and `device_revoked`
machine codes for tombstoned credentials. `POST /api/v1/token/refresh` rotates
the credential and keeps the previous one usable on that endpoint for 60
seconds only.

## Setup E2E

`scripts/e2e-setup-flow.sh` runs against a real Connect instance and a fresh
lunad. It pairs through an authenticated verified Connect account, waits for
lunad to claim, assigns the domain, and then checks off-LAN first-Admin setup: it refuses
no token, a wrong token, and the rolling credential, and accepts the device token from the
`/setup#token=<token>` fragment.
See the required environment variables at the top of the script.

The mock contract test script is available as:

```bash
python3 scripts/mocks/test-mock-connect.py
```
