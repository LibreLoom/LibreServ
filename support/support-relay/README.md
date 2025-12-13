# Support Relay

A lightweight relay service used for remote support sessions. Devices and support agents both connect outbound (WebSocket) using a shared session code. The relay simply bridges the streams; authentication and scoping stay on the device/agent apps.

## Running

```bash
cd support-relay
go run ./cmd/relay
# or build
go build -o bin/support-relay ./cmd/relay
./bin/support-relay
```

Environment:

- `RELAY_ADDR` – listen address (default `:8443`). Run behind TLS termination or a reverse proxy for production.
- `RELAY_HMAC_SECRET` – shared secret required to authenticate WS connections. Clients must send `code`, `role`, `nonce`, `ts` (unix), and `sig=HMAC(secret, code|role|nonce|ts)`.

Endpoints:

- `GET /healthz` – basic liveness.
- `GET /ws?role=device|agent&code=<session_code>&nonce=<nonce>&ts=<unix_ts>&sig=<hmac>` – establish a relay socket.

## Behavior

- Accepts one device connection and one agent connection per `code`.
- When both sides are present, frames are bridged bidirectionally.
- Sessions expire after a period of inactivity.
- Ping/pong heartbeats keep connections alive; both ends are notified on closure.

## Notes

- Keep the relay simple—no long-term storage or secrets are handled here.
- Layer your own authentication/authorization at the device/agent before connecting.
- Run behind TLS/HTTP/2 and place it close to a TURN/ICE stack if you also use WebRTC for media/side-channels. This relay is data-channel only.
