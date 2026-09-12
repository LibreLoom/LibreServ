# EuroOffice on Luna

Luna opens office files in the browser with **EuroOffice only**. There is no
built-in Luna office editor. The heavy editor is EuroOffice on the client.
Lunad only serves the optional asset pack and runs a thin collab relay.
Luna never runs a Document Server container as part of the Luna product.

## How it works

1. Opening a `.docx` / `.xlsx` / `.pptx` (and related) file mounts `OfficeEditor`.
2. Luna probes `/eurooffice/web-apps/apps/api/documents/api.js` (must be real
   JavaScript — not Luna’s HTML SPA fallback).
3. **If EuroOffice is missing:** the file opens in the **normal modal** with a
   clear “not installed” message and Download. No fullscreen for an error.
4. **If EuroOffice is present:** Luna escalates to a **fullscreen** shell
   (`HeaderCard` + shared `Button` chrome, close top-right), mints a
   short-lived office session (`POST /api/v1/office/session`), loads DocsAPI,
   and mounts EuroOffice for live editing. DocsAPI `customization.uiTheme`
   follows Luna light/dark; `customization.logo` uses Luna’s favicons.
   Peers also join the Luna collab socket for presence (shown in the header).
5. Document Server fetches the file from
   `/api/v1/public/office/content?token=…` (no browser cookies) and posts saves
   to `/api/v1/public/office/callback?token=…`. Set `LUNA_OFFICE_FETCH_ORIGIN`
   to a base URL the Document Server container can reach (dev default:
   `http://host.containers.internal:8090`).
6. Collab relay: `GET /api/v1/collab/ws?drive_id=&path=`. Document bytes still
   move through the office session URLs (and EuroOffice’s own save path).

## Installing EuroOffice assets (required to edit)

EuroOffice is AGPL-3.0. LibreServ does **not** ship the binaries in git.

Place the EuroOffice `web-apps` / `sdkjs` tree under Luna’s data dir so this
file exists:

```text
{data_dir}/eurooffice/web-apps/apps/api/documents/api.js
```

In this cloud/dev checkout, `data_dir` is `luna/dev` (`LUNA_DATA_DIR`).

### From the EuroOffice Document Server image (dev)

```bash
cd luna
make eurooffice          # assets + DS sidecar (pulls ~4.4GB image once)
# or individually:
make eurooffice-assets   # extract web-apps/sdkjs/fonts → $LUNA_DATA_DIR/eurooffice
make eurooffice-ds       # Document Server sidecar on :8088 (DS_PORT to override)
make eurooffice-ds-stop  # remove the sidecar
# Restart lunad so it nests ServeDir for /eurooffice
```

`eurooffice-assets` wraps `scripts/install-eurooffice-assets.sh`; `LUNA_DATA_DIR`
defaults to `luna/dev` (Make `DATA_DIR`), `EUROOFFICE_IMAGE` overrides the image.

Manual fallback (same thing, by hand):

```bash
cid=$(podman create ghcr.io/euro-office/documentserver:latest)
mkdir -p "$LUNA_DATA_DIR/eurooffice"
podman cp "$cid:/var/www/euro-office/documentserver/web-apps" "$LUNA_DATA_DIR/eurooffice/web-apps"
podman cp "$cid:/var/www/euro-office/documentserver/sdkjs" "$LUNA_DATA_DIR/eurooffice/sdkjs"
podman rm "$cid"
podman run -d --name eurooffice-ds \
  --add-host=host.containers.internal:host-gateway \
  -p 8088:80 -e JWT_ENABLED=false \
  -e ALLOW_PRIVATE_IP_ADDRESS=true ghcr.io/euro-office/documentserver:latest
```

lunad serves `{data_dir}/eurooffice` at `/eurooffice` when that directory exists.

The `eurooffice-ds` sidecar is the local DocsAPI runtime (conversion /
co-authoring endpoints). In Vite dev, Luna loads DocsAPI from it so editor
assets and `/coauthoring` resolve correctly. It runs with `JWT_ENABLED=false`
— JWT request signing is off because this container is a local dev helper
only; lunad and the DS sit on the same machine and the loopback port is not
exposed. It also sets `ALLOW_PRIVATE_IP_ADDRESS=true` so the DS is allowed to
fetch documents from lunad via `host.containers.internal`, which resolves to a
private/link-local address. Both are acceptable here but **never** in
production: that helper is
**not** Luna’s product Document Server — production Luna stays client-pack +
thin relay, with a companion Document Server only when you choose to run one
(and that one should keep JWT enabled).

### Env vars

| Var | Set on | Default | Purpose |
|---|---|---|---|
| `LUNA_OFFICE_FETCH_ORIGIN` | lunad | `http://host.containers.internal:{LUNA_PORT\|8090}` | Base URL the DS container uses to reach lunad for fetch/callback |
| `LUNA_DOCUMENT_SERVER_URL` | lunad | `http://127.0.0.1:8088` | DS URL rewritten into office session configs |
| `VITE_EUROOFFICE_DS_URL` | Vite dev | `http://127.0.0.1:8088` (dev only; empty in prod) | Browser-reachable DS origin for DocsAPI |

Distributors who ship EuroOffice assets must comply with AGPL-3.0 (source offer,
license notice). See [`THIRD_PARTY_EUROOFFICE.md`](../THIRD_PARTY_EUROOFFICE.md).

## Collab protocol (summary)

Client → server: `hello`, `op` (opaque JSON payload), `presence`, `saved`, `ping`  
Server → client: `welcome`, `peer_join`, `peer_leave`, `op`, `presence`, `saved`,
`error`, `pong`, `evict`

Lunad does not interpret `op.payload`. Every peer with ACL write access may send
ops. EuroOffice owns document semantics; Luna only fans frames out and tracks
who is in the room.

## Creating blank office files

“New document / spreadsheet / presentation” still creates minimal OOXML stubs on
the drive. Opening them still requires EuroOffice.
