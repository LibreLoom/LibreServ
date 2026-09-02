# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreloom.org`.

Bind is **offline on the website**: you enter the permanent device code
(`****-****-****-****-****`), pick a name, and optionally turn on cloud backup.
Luna then pulls `GET /api/v1/status` on boot and every 5 minutes (Bearer = full
device code). **200** applies tunnel/domain/backup; **403** means unbound and
Luna clears remote access.

Routes: `/onboarding` (official) and `/diyonboarding` (bring-your-own, $1 mint).
`/register` redirects to `/diyonboarding`.

The public address is free: `https://{name}.luna.servers.libreloom.org`.

Cloud backups are an off-site copy of chosen folders or whole drives — not version history. They cost **$8 per terabyte each month** (Stripe metered at **$0.008 per GB-month** on the **month’s average** storage — Backblaze B2–style, not a last-day snapshot). Downloads are free up to **3× average storage**; overage is **$0.01 per GB**. Billed after you add a payment card here. Luna uploads during idle time. When Admin → Connections has an enabled Backblaze B2 provider, each Luna gets its own private B2 bucket; otherwise objects stay on this server’s disk.

Backup to the cloud is planned as the only paid product. The address never requires a card.

## Device codes

One permanent **device code** per Luna. The **first eight characters** (`****-****`) unlock remote setup on the box; the **full code** binds on this site.

Connect is optional. Local-only / air-gap installs may skip the code at flash time; then only loopback (on-box) setup is allowed — remote setup never fail-opens.

Unbind on the dashboard archives backups (`User → Backups → Luna*-uuid`), frees the name, and returns 403 on status until rebound. Factory reset keeps the on-disk device-code file so a still-bound account auto re-provisions on the next status pull.

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

Staff mint official unbound device codes (single or bulk). DIY mints a code after the $1 payment on `/diyonboarding`. Bulk export is a single-code `TOKENS` list (plus metadata), not a paired setup+device file.

Support looks up by order ref or code hint and can reveal or replace the device code (audited). Quick-start print shows one code; note that the first eight characters unlock phone setup.

Staff admin: first account via `/admin/seed` (loopback, or `auth.admin_seed_token` + `X-Seed-Token`), then `/admin/login`. Console: Dashboard, Devices, Device codes, Accounts, Connections, Security.

## Deploy (ZDU)

Same blue/green pattern as LibreServ Connect: two systemd instances behind Caddy, shared SQLite + object dir.

**How drain works:** `deploy.sh` touches `/var/lib/luna-connect/drain-{a|b}`. That instance’s `/healthz` returns **503** while it still serves in-flight requests. Caddy’s active health check drops it, then the script stops the unit, swaps the binary, clears the drain file, and starts it again. The peer must be healthy before either side is drained (otherwise you get a site-wide 503).

```bash
# once on the box (also re-run after unit-template changes)
sudo bash luna-connect/deploy/setup.sh
# merge deploy/Caddyfile.conf into /etc/caddy/Caddyfile (BOTH :8101 and :8102), then:
sudo caddy reload --config /etc/caddy/Caddyfile

# later (must be root — systemctl stop/start)
sudo ./luna-connect/deploy/deploy.sh --head
# same when already on main:
# sudo ./luna-connect/deploy/deploy.sh
# sudo ./luna-connect/deploy/deploy.sh --head --force   # one instance already sick
# build exactly this checkout (no pull):
# sudo ./luna-connect/deploy/deploy.sh --no-pull

# pinned release (when you need an older tag, not current main):
# sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
# sudo ./luna-connect/deploy/deploy.sh --latest-tag
```

Instances: `luna-connect-a` `:8101`, `luna-connect-b` `:8102`. Shared DB: `/var/lib/luna-connect/luna-connect.db`. Host: `connect.luna.libreloom.org`.

Fill Cloudflare (tunnel + DNS for `*.luna.servers.libreloom.org`) and Stripe in both `/etc/luna-connect/luna-connect-{a,b}.yaml` (same `admin_token` and `at_rest_key` on both), or set them in Admin → Connections (shared SQLite). Cloudflare and Stripe yaml values are the fallback when nothing is enabled in the database.

## Tests

```bash
make test
make lint
```
