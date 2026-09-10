# EuroOffice on Luna

Luna opens office files in the browser with **EuroOffice only**. There is no
built-in Luna office editor. The heavy editor is EuroOffice on the client.
Lunad only serves the optional asset pack and runs a thin collab relay.
Luna never runs a Document Server container.

## How it works

1. Opening a `.docx` / `.xlsx` / `.pptx` (and related) file opens a **fullscreen**
   shell (close control top-right) and mounts `OfficeEditor`.
2. Luna probes `HEAD /eurooffice/web-apps/apps/api/documents/api.js`.
3. **If EuroOffice is present:** Luna loads DocsAPI and mounts EuroOffice for
   live editing. Peers also join the Luna collab socket for presence.
4. **If EuroOffice is missing:** Luna shows a clear “not installed” message and
   Download. It does **not** fall back to a plain-text editor.
5. Collab relay: `GET /api/v1/collab/ws?drive_id=&path=`. Document bytes still
   move through the normal files API (and EuroOffice’s own save path when the
   pack provides one).

## Installing EuroOffice assets (required to edit)

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
Server → client: `welcome`, `peer_join`, `peer_leave`, `op`, `presence`, `saved`,
`error`, `pong`, `evict`

Lunad does not interpret `op.payload`. Every peer with ACL write access may send
ops. EuroOffice owns document semantics; Luna only fans frames out and tracks
who is in the room.

## Creating blank office files

“New document / spreadsheet / presentation” still creates minimal OOXML stubs on
the drive. Opening them still requires EuroOffice.
