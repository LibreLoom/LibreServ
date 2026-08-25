# Atlas-bot runner (Forgejo)

Podman service. Jobs run **inside** this container (`runs-on: atlas` = host executor of the container). Isolation from the Forgejo host is: no runtime socket bind, no compose-data binds, `no-new-privileges`, user 10000.

Do not reuse `agents/nightly`.

## Max: click these

1. Forgejo user `atlas-bot` already exists. Create an **access token** as that user (or `forgejo admin user generate-access-token -u atlas-bot`). Scopes: repository write, issue write, org read (must be able to list team **Owners** members).
2. Org **Actions secrets** on LibreLoom (`/org/LibreLoom/-/settings/actions/secrets`):
   - `ATLAS_BOT_TOKEN` = that token
   - `AI_PROXY_API_KEY` = existing ai-proxy key (same as nightly)
3. Org **Actions runner** (`/org/LibreLoom/-/settings/actions/runners`): create a runner, copy the registration token. No runner exists yet.
4. On the Forgejo host, from this repo:

```
cd agents/atlas-runner
export ATLAS_BOT_TOKEN=...
export AI_PROXY_API_KEY=...
export ATLAS_WEBHOOK_SECRET=...   # random, also used as org webhook secret
podman compose build
podman compose run --rm --entrypoint forgejo-runner atlas-bot register --no-interactive \
  --instance https://gt.plainskill.net \
  --token <RUNNER_REGISTRATION_TOKEN> \
  --name atlas-bot \
  --labels atlas
# The generated /data/.runner must live in the atlas-bot-data volume.
podman compose up -d
```

5. Connect `atlas-bot` to the same podman network as container `forgejo` so Forgejo can reach `http://atlas-bot:8787/webhook`.
6. Org webhook (`/org/LibreLoom/-/settings/hooks`):
   - Target: `http://atlas-bot:8787/webhook`
   - Secret: same as `ATLAS_WEBHOOK_SECRET`
   - Events: Issue comments, Issues, Pull requests (assigned / opened / comments)
7. Confirm Owners team members are the people who may invoke. Team already exists.

LibreServ workflows pick up jobs labeled `atlas`. Other LibreLoom repos work via the org webhook even without a workflow file.
