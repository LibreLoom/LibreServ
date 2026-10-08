# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreloom.org`.

Bind is **offline on the website**: you enter the permanent device token
(`****-****-****-****-****`), pick a name, and optionally turn on cloud backup.
Luna then pulls `GET /api/v1/status` on boot and every 5 minutes (Bearer = full
device token). **200** applies tunnel/domain/backup; **JSON 403** means unbound and
Luna clears remote access. A **Cloudflare managed-challenge 403** (HTML / 
`cf-mitigated: challenge`) is **not** an unbind — Luna keeps `connect.json` and
shows a sticky reachability error until Connect returns real JSON again.

Routes: `/onboarding` (official) and `/diyonboarding` (bring-your-own, $1 mint).
`/register` redirects to `/diyonboarding`.

The public address is free: `https://{name}.luna.servers.libreloom.org`.

Cloud backups are an off-site copy of chosen folders or whole drives — not version history. They cost **$8 per terabyte each month** (Stripe metered at **$0.008 per GB-month** on the **month’s average** storage — Backblaze B2–style, not a last-day snapshot). Downloads are free up to **3× stored amount**; overage is **$0.01 per GB**. Billed after you add a payment card here. Luna uploads during idle time. When Admin → Connections has an enabled Backblaze B2 provider, each Luna gets its own private B2 bucket; otherwise objects stay on this server’s disk.

Backup to the cloud is planned as the only paid product. The address never requires a card.

## Bot challenges in front of the device API

Luna devices call `/api/v1/*` on the public hostname with a Bearer device token.
They cannot solve browser JavaScript challenges, so a CDN or firewall bot
challenge on that path (HTML `403` with `cf-mitigated: challenge`) breaks
status pulls: Luna keeps its local bind state, but **tunnel tokens stop
refreshing** until the challenge stops. Exempt `/api/v1/*` from bot challenges
in production. Reproduce locally with
`luna/scripts/mocks/mock-connect-cf-challenge.py` and
`luna/scripts/mocks/repro-cf-challenge-403.sh`.

## Device tokens
 
One permanent **device token** per Luna. The **full token** binds on this site and unlocks remote setup on the box — Luna's account-creation step asks for the full token (no 8-char prefix gate). Connect's onboarding links to `/setup?token=` with the full token to prefill it.
 
Connect is optional. Local-only / air-gap installs may skip the token at flash time; setup stays open on the LAN, and first registration over the public hostname still asks for the device token — remote first login never fail-opens.
 
Unbind on the dashboard archives backups (`User → Backups → Luna*-uuid`), frees the name, and returns 403 on status until rebound. Factory reset keeps the on-disk device-token file so a still-bound account auto re-provisions on the next status pull.

## Run

```bash
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make build
make run
```

Env prefix: `LUNACONNECT_` (viper), e.g. `LUNACONNECT_SERVER_PORT`.

Stripe only skips real charges in **explicit local/dev**: set `LUNACONNECT_DEV=1` and `stripe.enabled: false`. Production must enable Stripe and fill `secret_key`, `publishable_key`, `webhook_secret`, storage + egress meter/price IDs. Use **Billing Meters** (not classic Usage Records).

### Stripe Dashboard setup (B2-style)

1. **Storage meter** — Billing → Meters → create meter:
   - Event name: `luna_backup_gb`
   - Aggregation: **Last** (gauge)
   - Luna Connect samples stored bytes hourly, computes the UTC calendar-month average, and reports that average GB (so emptying before invoice does not zero the charge).
2. **Storage price** — usage-based, **$0.008 per GB**, linked to `luna_backup_gb`. Do not reuse old Usage Record or $0.80 / 0.1 TB prices.
3. **Egress meter** — event name `luna_backup_egress_gb`, aggregation **Last**.
4. **Egress price** — usage-based, **$0.01 per GB**, linked to `luna_backup_egress_gb`. Only **overage** is reported: `max(0, egress − 3 × average_storage)` in GB. Free under the 3× allowance is never sent to Stripe.
5. Put both price IDs and meter event names in yaml or Admin → Connections. New subscriptions attach both prices.

Empty keys refuse paid routes (fail closed). `stripe.enabled: false` by itself does **not** unlock cloud backup.

## Factory / support

Staff mint official unbound device tokens (single or bulk). DIY mints a token after the $1 payment on `/diyonboarding`. Bulk export is a single-token `TOKENS` list (plus metadata), not a paired setup+device file.

Support looks up by order ref or token hint and can reveal or replace the device token (audited). Quick-start print shows one token; that full token unlocks remote setup (paste it when the setup form asks) — not just the first eight characters.

Staff admin: first account via `/admin/seed` (loopback, or `auth.admin_seed_token` + `X-Seed-Token`), then `/admin/login`. Console: Dashboard, Devices, Device tokens, Accounts, Connections, Security.

## Deploy (ZDU)

Same blue/green pattern as Sol Connect: two systemd instances behind Caddy, shared database + object dir.

**How drain works:** `deploy.sh` touches `/var/lib/luna/connect/drain-{a|b}`. That instance’s `/healthz` returns **503** while it still serves in-flight requests. Caddy’s active health check drops it, then the script stops the unit, swaps the binary, clears the drain file, and starts it again. The peer must be healthy before either side is drained (otherwise you get a site-wide 503).

```bash
# once on the box (also re-run after unit-template changes)
sudo bash luna/connect/deploy/setup.sh
# merge deploy/Caddyfile.conf into /etc/caddy/Caddyfile (BOTH :8101 and :8102), then:
sudo caddy reload --config /etc/caddy/Caddyfile

# later (must be root — systemctl stop/start). `deploy.sh` is a thin wrapper around the
# shared script infra/connect-deploy/deploy.sh (unit luna-connect). Needs `minisign` and `jq`.
# default: newest signed release from the stable feed; nothing is built on the server.
# The signing key (keys/lsluna.minisign.pub) is read from this checkout, so `git pull` first.
sudo ./luna/connect/deploy/deploy.sh
# beta channel:
# sudo ./luna/connect/deploy/deploy.sh --channel beta
# one exact release (its signed SHA256SUMS.txt); older than installed needs --allow-downgrade:
# sudo ./luna/connect/deploy/deploy.sh --version 0.2.17
# dev: reset to origin/main and build on the server:
# sudo ./luna/connect/deploy/deploy.sh --head
# sudo ./luna/connect/deploy/deploy.sh --head --force   # one instance already sick
# dev: build exactly this checkout (no pull), or origin/NAME:
# sudo ./luna/connect/deploy/deploy.sh --no-pull
# sudo ./luna/connect/deploy/deploy.sh --branch NAME
# fetch + verify + unpack only, no install, no root:
# ./luna/connect/deploy/deploy.sh --stage-only
```

Installed version and the newest feed time seen are remembered in `/var/lib/connect-deploy/luna-connect/`. The old `luna-connect-v*` tags and `--tag` / `--latest-tag` are retired. Settings live in `infra/connect-deploy/units/luna-connect.conf`; tests: `bash infra/connect-deploy/test.sh`.

Two instances run side by side so a deploy can update them one at a time. They share a database: PostgreSQL in production (`database.driver` / `database.url` in each instance's config), SQLite for local dev. Instance names, ports and install paths are in `infra/connect-deploy/units/luna-connect.conf`.

**Inbound must be Cloudflare-only.** The app trusts `CF-Connecting-IP`/`X-Forwarded-For` for client IPs (rate limits, admin gating) because `deploy/Caddyfile.conf` aborts any request that did not arrive from a Cloudflare edge IP. Do not remove that matcher, and keep the host firewall restricted to the proxy's address ranges as well — a direct-origin request could otherwise forge client IPs.

Fill Cloudflare (tunnel + DNS for the device domain) and Stripe in both instances' config files (same `admin_token` and `at_rest_key` on both), or set them in Admin → Connections (shared SQLite). Cloudflare and Stripe yaml values are the fallback when nothing is enabled in the database.

## Tests

```bash
make test
make lint
```
