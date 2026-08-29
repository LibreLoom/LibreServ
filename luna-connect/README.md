# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreloom.org`.

The main feature is remote access: sign in to pair your Luna and open it away from home at `https://{name}.luna.servers.libreloom.org`. That address is free.

Cloud backups are an off-site copy of chosen folders or whole drives — not version history. They cost **$8 per terabyte each month** (Stripe metered at **$0.008 per GB-month** on the **month’s average** storage — Backblaze B2–style, not a last-day snapshot). Downloads are free up to **3× average storage**; overage is **$0.01 per GB**. Billed after you add a payment card here. Luna uploads during idle time. When Admin → Connections has an enabled Backblaze B2 provider, each Luna gets its own private B2 bucket; otherwise objects stay on this server’s disk.

Backup to the cloud is planned as the only paid product. The address never requires a card.

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

## Official setup codes (purchased from LibreLoom)

Official units that lost their setup file cannot start on their own. There is no public “I lost my code” form. The owner contacts support and refers to their order id. Support then issues a replacement official token (admin New token page at `/admin/login`). Put it on Luna, or add it as a line in `TOKENS` on the installer USB’s **LUNAASSETS** partition (factory magazine: each flash peels the first line). A one-shot `setup-token` file next to the ISO payload still works for a single unit.

Staff admin: first account via `/admin/seed` (loopback, or `auth.admin_seed_token` + `X-Seed-Token`), then `/admin/login`. Console: Dashboard, Devices, Setup codes, Accounts, Security. Bulk factory lists download as a file named **`TOKENS`** (Crockford official setup codes, one per line — same format as a single remint).

## Deploy (ZDU)

Same blue/green pattern as LibreServ Connect: two systemd instances behind Caddy, `/healthz` drain, shared SQLite + object dir.

```bash
# once on the box
sudo bash luna-connect/deploy/setup.sh
# merge deploy/Caddyfile.conf into /etc/caddy/Caddyfile, then:
sudo caddy reload --config /etc/caddy/Caddyfile

# later
./luna-connect/deploy/deploy.sh --head
# or after tagging: git tag luna-connect-v0.1.0 && git push --tags
# ./luna-connect/deploy/deploy.sh
```

Instances: `luna-connect-a` `:8101`, `luna-connect-b` `:8102`. Shared DB: `/var/lib/luna-connect/luna-connect.db`. Host: `connect.luna.libreloom.org`.

Fill Cloudflare and Stripe in both `/etc/luna-connect/luna-connect-{a,b}.yaml` (same `admin_token` and `at_rest_key` on both), then restart both units.

## Tests

```bash
make test
make lint
```
