# Luna Desktop Flatpak repo server

Serves the Luna Desktop Flatpak repo at `https://flatpak.luna.libreloom.org`
(a Caddy site on a server we run). Spec: `../ci-source/internal/feed/README.md`.

## What it does

A systemd timer runs `watch.sh` as the `luna-flatpak` user every 5 minutes.
For each channel (`stable`, `beta`) it:

1. Fetches `feeds/luna-desktop/<channel>.json` + `.json.minisig` and verifies it
   against `keys/lsluna.minisign.pub`. A missing feed (404) is normal.
2. Skips unless `published` is not older than the newest seen and `version` is
   strictly newer than the last imported one (strict semver, `-beta.N` aware).
3. Downloads the `flatpak` (linux, amd64) part, checks size and sha256.
4. Checks the bundle's ref is exactly `app/org.libreloom.LunaDesktop/x86_64/<channel>`
   (refuses otherwise), imports it into `/srv/luna-flatpak/repo` signed with the
   repo GPG key, and runs `build-update-repo` (static deltas, prune keeping 3
   commits per ref).
5. Rebuilds the installable bundle **from our signed repo**
   (`flatpak build-bundle ... --repo-url --gpg-keys --runtime-repo`) as
   `bundles/luna-desktop-<channel>.flatpak`, and rewrites the `.flatpakref` /
   `.flatpakrepo` files.
6. Records the new `published` + `version` in `/var/lib/luna-flatpak/state/`.

The feed's bundle is only the server's input (built by CI with branch = channel,
no repo URL, no GPG keys). Users install the rebuilt bundle, so their remote
verifies our signatures. Branch names can't be changed on import, so the CI
bundle must already be built for the channel it is published in.

With nothing new, a run changes nothing. A lock stops overlapping runs.

## Files

| File | Purpose |
|---|---|
| `watch.sh` | the watcher (all paths overridable by env vars, see top of file) |
| `luna-flatpak-watch.service` / `.timer` | systemd units (hardened, runs as `luna-flatpak`) |
| `Caddyfile.conf` | Caddy site; setup.sh copies it to `/etc/caddy/luna-flatpak.caddy` |
| `setup.sh` | one-time server setup (idempotent) |
| `test-semver.sh` | checks `watch.sh`'s semver compare against `feed-testdata/cases.json` |

On the server: repo at `/srv/luna-flatpak/repo`, bundles in
`/srv/luna-flatpak/bundles/`, `luna.flatpakrepo` and
`luna-desktop-<channel>.flatpakref` in `/srv/luna-flatpak/`, state and GPG home
in `/var/lib/luna-flatpak/{state,gnupg}`.

## Setup

```
sudo /opt/LibreServ/infra/flatpak-repo/setup.sh
```

Then import the Caddy site that setup.sh installs (see `Caddyfile.conf`),
reload Caddy, and route `flatpak.luna.libreloom.org` to it. If a CDN fronts the
hostname, add a cache rule that respects the origin's `Cache-Control`, or the
repo files are not cached at the edge.

## Operating

```
sudo systemctl start luna-flatpak-watch.service     # run now
journalctl -u luna-flatpak-watch -n 100             # logs
systemctl list-timers luna-flatpak-watch.timer      # next run
```

To re-import a version: delete `/var/lib/luna-flatpak/state/<channel>.version`
(and `.published` if you need to go older), then run the service.

The GPG signing key lives in `/var/lib/luna-flatpak/gnupg` (only `luna-flatpak`
can read it). Keep an offline backup. The public key is
`keys/luna-desktop-flatpak.gpg`.

## How people get it

Users open `https://flatpak.luna.libreloom.org/bundles/luna-desktop-stable.flatpak`
(or `-beta`) in their software center. Installing the bundle adds this repo as
a signed source, so later updates arrive through the normal software center.
`luna-desktop-<channel>.flatpakref` and `luna.flatpakrepo` are served too.
