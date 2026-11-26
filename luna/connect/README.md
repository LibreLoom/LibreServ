# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreloom.org`.

Pairing requires a verified Connect account and a running Luna. The account
starts with `POST /api/v1/devices/pair`, using the Luna's 20-character Crockford
**device token** (`7K4M-2Q9X-R8N3-6T5W-1PZH`), then polls the returned pairing
ID. While unbound, Luna polls `POST /api/v1/devices/pair/claim` with the same
token. A successful claim returns a hidden rolling `auth_token`; the device token
is not an ongoing credential. Contract: `../docs/connect-auth/DESIGN.md`.

Once bound, Luna uses the rolling credential as Bearer auth for
`GET /api/v1/status` and the other device routes. It refreshes the credential
every five minutes and after reconnect through `POST /api/v1/token/refresh`.
Refreshing invalidates the old credential, with a 60-second overlap only on the
refresh endpoint; unbind and revocation invalidate it immediately. A
**Cloudflare managed-challenge 403** (HTML / `cf-mitigated: challenge`) is not an
unbind — Luna keeps its local state and shows a reachability error until Connect
returns real JSON again.

Routes: `/onboarding` (official) and `/diyonboarding` (bring-your-own, $1 mint).
`/register` redirects to `/diyonboarding`.

The public address is free: `https://{name}.luna.servers.libreloom.org`.

Cloud backups are an off-site copy of chosen folders or whole drives — not version history. They cost **$8 per terabyte each month** (Stripe metered at **$0.008 per GB-month** on the **month’s average** storage — Backblaze B2–style, not a last-day snapshot), with a **$3 minimum per month** once anything is stored. The minimum is applied on our side by topping up the storage quantity we report (375 GB bills $3.00), so the Stripe price stays a plain $0.008/GB; nothing stored bills nothing. Downloads are free up to **3× stored amount**; overage is **$0.01 per GB**. Billed after you add a payment card here. Luna uploads during idle time. When Admin → Connections has an enabled Backblaze B2 provider, each Luna gets its own private B2 bucket; otherwise objects stay on this server’s disk.

Backup to the cloud is planned as the only paid product. The address never requires a card.

## Bot challenges in front of the device API

Luna devices call `/api/v1/*` on the public hostname. Pairing claims use the
device token; bound requests use a Bearer rolling credential.
Devices cannot solve browser JavaScript challenges, so a CDN or firewall bot
challenge on that path (HTML `403` with `cf-mitigated: challenge`) breaks pairing
or status and credential refreshes: Luna keeps its local bind state, but
**tunnel tokens stop refreshing** until the challenge stops. Exempt `/api/v1/*`
from bot challenges in production. Reproduce locally with
`luna/scripts/mocks/mock-connect-cf-challenge.py` and
`luna/scripts/mocks/repro-cf-challenge-403.sh`.

## Device tokens

The product's **Device token** section holds one 20-character Crockford token,
stored ungrouped in `device-token` on Luna with mode `0600`. The rolling
`auth_token` is stored separately in `connect-credential` with mode `0600` and is
never shown to a user. The old permanent-token files, `device-uid`,
`pairing-code`, and `first_user_secret` are removed.

Only Connect staff (admin console) and the DIY flow (after its $1 card check)
mint tokens, and nothing rotates or re-mints one. Connect stores a hash of the
token plus a short hint for support, so it cannot show a token again; the token
is displayed once, when it is minted.

The token is accepted only while the device is unbound or has an active pairing
attempt, and pairing can repeat. The first valid claim wins and closes pairing.
Unbind keeps the token but revokes the rolling credential; account revocation
moves the device to `revoked` until account-authorized recovery starts a new
pairing attempt.

Connect is optional. Local-only or air-gapped installs may skip pairing at flash
time, and first registration stays open on the LAN. Off-LAN first registration
requires the full device token, which Luna checks against its own `device-token`
file; Connect is not asked. Connect's onboarding links to
`/setup#token=<token>` (URL fragment, never the query string) to prefill it.
There is no setup grant.

Unbind on the dashboard archives backups (`User → Backups → Luna*-uuid`), frees
the name, and invalidates the rolling credential. Factory reset offers **Keep
Connect** or **Disconnect**, and the device token survives both. Keep Connect retains the rolling credential and bound
configuration while clearing local Luna data. Disconnect uses the normal unbind
flow; if Connect is unavailable, the reset retains pending revocation state and
blocks remote access and pairing until revocation succeeds.

## Run

```bash
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make build
make run
```

Env prefix: `LUNACONNECT_` (viper), e.g. `LUNACONNECT_SERVER_PORT`.

Stripe only skips real charges in **explicit local/dev**: set `LUNACONNECT_DEV=1` and `stripe.enabled: false`. Production must enable Stripe and fill `secret_key`, `webhook_secret`, storage + egress meter/price IDs (`publishable_key` is no longer used: payments happen on Stripe's hosted page). Use **Billing Meters** (not classic Usage Records).

### Stripe Dashboard setup (B2-style)

Payments run through **Stripe Managed Payments**: Stripe (through Link) is the merchant of record and adds, files and remits sales tax and VAT on top of our prices. Background and sandbox results: `docs/billing-managed-payments.md`.

0. **Managed Payments** — Settings → Managed Payments → turn on (live mode needs Stripe's eligibility review). Settings → Business details: the support email must be right; Link escalates customer questions there.

1. **Storage meter** — Billing → Meters → create meter:
   - Event name: `luna_backup_gb`
   - Aggregation: **Last** (gauge)
   - Luna Connect samples stored bytes hourly, computes the UTC calendar-month average, and reports that average GB (so emptying before invoice does not zero the charge).
2. **Storage price** — usage-based, **$0.008 per GB**, linked to `luna_backup_gb`, tax behavior **exclusive**. Its product needs tax code `txcd_10010001` (Infrastructure as a service, personal use) or Managed Payments refuses it. Do not reuse old Usage Record or $0.80 / 0.1 TB prices.
3. **Egress meter** — event name `luna_egress_gb`, aggregation **Last**.
4. **Egress price** — usage-based, **$0.01 per GB**, linked to `luna_egress_gb`, tax behavior **exclusive**, product tax code `txcd_10010001`. Only **overage** is reported: `max(0, egress − 3 × average_storage)` in GB. Free under the 3× allowance is never sent to Stripe.
5. Put both price IDs and meter event names in yaml or Admin → Connections. New subscriptions attach both prices.
6. **Billing period** — each subscription's cycle is anchored to 00:00 UTC on the 1st, so a Stripe invoice covers the same UTC month the usage average is computed over (the first period is the partial month). Usage is reported at startup and then hourly.
7. **Card check** — the one-time $1 check (DIY onboarding) is its own Managed Payments Checkout. Its product is created inline ("Cloud backup credit", tax code `txcd_10010001`), so nothing to set up. The card is saved, and the cloud backup Checkout offers it again in one click. The $1 comes back as a $1 Stripe credit grant.
8. **Credit** — account credit is Stripe billing credits (credit grants, metered prices only). Stripe takes it off cloud backup invoices before tax. Admin → Accounts → Credit creates promotional grants.
9. **Webhook** — endpoint `https://<host>/api/v1/billing/webhook`, API version `2026-10-28.endive` (what stripe-go v87 sends) for a new endpoint; the production endpoint (`we_1U9rGB2YkLLziVSu8JRAUTBk`) stays on `2026-08-26.dahlia`, which also works (an endpoint's version can't be changed, and the sandbox tests ran on dahlia events). Events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`. Stripe doesn't always send `invoice.payment_failed` (seen in the sandbox: a failed charge right after a billing-cycle change sent only `customer.subscription.updated` → `past_due`), so the subscription update is handled too.
10. **Failed or unconfirmed payments** — the API can't change the card or pay a Managed Payments invoice with another card. The unpaid invoice's own Stripe page (`hosted_invoice_url`, Link-branded) lets the customer confirm the payment with their bank (3D Secure) or pay with a different card; tested in the sandbox. Connect links it in the warning mail, on the Backups page and in the 409 from checkout, with link.com as the fallback. `invoice.paid` unlocks backups again.
11. **Turn off payment** — reports the month's usage and ends the subscription 10 minutes later (`cancel_at`), because Stripe processes meter events about a minute after they're sent and an immediate cancel billed $0. Meanwhile the account is `canceling` (backups off; no webhook can unlock it or start a countdown; no new subscription). On `customer.subscription.deleted` (or the next `/me` or checkout, if that webhook never comes) Connect charges the final invoice, unlinks the account and clears the month's usage samples.

Empty keys refuse paid routes (fail closed). `stripe.enabled: false` by itself does **not** unlock cloud backup.

## Factory / support

Staff mint official unbound device tokens, singly or in bulk. DIY provisioning
mints one after its payment step. Each `TOKENS` line is exactly one field:

```text
7K4M2Q9XR8N36T5W1PZH
```

The installer writes it to `device-token`. The printable quick-start shows it,
and it also unlocks remote first-Admin setup (Luna checks it locally).

Connect keeps only a hash, so support looks up devices by order reference or the
token's hint, never by the token itself. Never log a device token. A lost token
is replaced by staff minting a new one.

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
# The signing key (keys/luna.minisign.pub) is read from this checkout, so `git pull` first.
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

**Inbound must be Cloudflare-only.** Connect believes `CF-Connecting-IP`/`X-Real-IP`/`X-Forwarded-For` only from a loopback peer or an address listed in `trusted_proxies`, so `deploy/Caddyfile.conf` must keep aborting any request that did not arrive from a Cloudflare edge IP and the host firewall must stay restricted to the proxy's address ranges. The shipped Caddy is on loopback and needs no entry; a proxy on another address (a Docker/LAN hop) must be listed in `trusted_proxies` or every client is bucketed as that proxy for rate limits and admin gating. List only a proxy you control — it can choose the client address Connect sees.

Fill Cloudflare (tunnel + DNS for the device domain) and Stripe in both instances' config files (same `at_rest_key` on both; staff sign in at `/admin/login`), or set them in Admin → Connections (shared SQLite). Cloudflare and Stripe yaml values are the fallback when nothing is enabled in the database.

## Tests

```bash
make test
make lint
```
