# EuroOffice on Luna

Luna edits office files in the browser with a **thin collab relay** in lunad.
The heavy editor runs on the client. Luna never runs a Document Server container.

## How it works

1. Opening a `.docx` / `.xlsx` / `.pptx` (and related) file mounts `OfficeEditor`.
2. Luna probes `HEAD /eurooffice/web-apps/apps/api/documents/api.js`.
3. If EuroOffice assets are present, Luna shows an AGPL notice. Until a DocsAPI
   bridge ships, editing still uses the built-in collaborative fallback editor.
4. If assets are missing, the same fallback editor runs with no AGPL notice.
5. Peers join `GET /api/v1/collab/ws?drive_id=&path=` for presence and opaque op
   fan-out. Saves go through the normal files upload API.

## Installing EuroOffice assets (optional)

EuroOffice is AGPL-3.0. LibreServ does **not** ship the binaries in git.

On a Luna device (or your build host):

```bash
# Example — adjust to the release you redistribute under AGPL obligations
sudo mkdir -p /var/lib/luna/eurooffice
# Place the EuroOffice web-apps / sdkjs tree so this file exists:
#   /var/lib/luna/eurooffice/web-apps/apps/api/documents/api.js
```

lunad serves `{data_dir}/eurooffice` at `/eurooffice` when that directory exists
(`data_dir` defaults to Luna’s configured data directory).

Distributors who ship EuroOffice assets must comply with AGPL-3.0 (source offer,
license notice). See [`THIRD_PARTY_EUROOFFICE.md`](../THIRD_PARTY_EUROOFFICE.md).

## Collab protocol (summary)

Client → server: `hello`, `op` (opaque JSON payload), `presence`, `saved`, `ping`  
Server → client: `welcome`, `peer_join`, `peer_leave`, `editor_changed`, `op`,
`presence`, `saved`, `error`, `pong`, `evict`

Lunad does not interpret `op.payload`. The fallback editor uses
`{ engine: "luna-fallback/1", text }`.

Only **one** ACL-writable peer holds the edit lease at a time. Others watch
live updates until the editor leaves, then the lease moves automatically.

## Safe saves

The fallback editor only overwrites `.docx` / `.xlsx` / `.pptx` with rebuilt
minimal OOXML from plain text. Other office types open for reading and live
notes, but Save stays disabled so the original file is not damaged.
