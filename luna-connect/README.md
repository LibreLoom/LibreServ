# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreloom.org`.

The main feature is remote access: sign in to pair your Luna and open it away from home at `https://{name}.luna.servers.libreloom.org`. That address is free.

Cloud backups are a spare copy of chosen folders or whole drives — not version history. They cost **$7 per terabyte each month**, billed through Stripe after the household adds a payment card here. Luna uploads during idle time.

Backup to the cloud is planned as the only paid product. The address never requires a card.

## Run

```bash
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make build
make run
```

Env prefix: `LUNACONNECT_` (viper), e.g. `LUNACONNECT_SERVER_PORT`.

Stripe only skips real charges in **explicit local/dev**: set `LUNACONNECT_DEV=1` and `stripe.enabled: false`. Production must enable Stripe and fill `secret_key`, `publishable_key`, `webhook_secret`, and `price_id`. Empty keys refuse paid routes (fail closed). `stripe.enabled: false` by itself does **not** unlock cloud copies.

## Official booklet codes

Official units that lost their setup file cannot start on their own. There is no public “I lost my code” form. The owner contacts support and refers to their order id. Support then issues a replacement official token (admin New token page) and they paste it on Luna or put `setup-token` on the installer USB.

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
