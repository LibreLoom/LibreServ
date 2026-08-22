# Luna Connect

Cloud companion for Luna. Public site: `https://connect.luna.libreserv.org`.

Each Luna is reachable at `https://{name}.luna.servers.libreloom.org` through a Cloudflare Tunnel. That address is free.

Cloud backups are a spare copy of chosen folders or whole drives — not version history. They cost **$7 per terabyte each month**, billed through Stripe after the household adds a payment card here. Luna uploads during idle time.

Backup to the cloud is planned as the only paid product. The address never requires a card.

## Run

```bash
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make build
make run
```

Env prefix: `LUNACONNECT_` (viper), e.g. `LUNACONNECT_SERVER_PORT`.

Without Cloudflare or Stripe keys, register still assigns a hostname and “add a card” works in local-dev mode so Luna can unlock backups against disk storage.

## Tests

```bash
make test
make lint
```
