# draw.io on Luna

Luna opens `.drawio` files (and the self-describing `.drawio.svg` /
`.drawio.png` variants) in a **self-hosted** diagrams.net editor. The hosted
`embed.diagrams.net` iframe is never used — it phones home to JGraph, and
this is a privacy product. The `.drawio` file on the drive IS the document:
it's plain XML, loaded into the editor and written back on save.

## How it works

1. Opening a diagram file mounts `DiagramEditor` in FileViewer's fullscreen
   shell immediately. Which files count is defined by `isDiagramFile` in
   `web/src/lib/fileKinds.js`: `.drawio` plus `.drawio.svg` / `.drawio.png`
   (classified before image/text so the embedded diagram wins over the
   preview it carries).
2. The editor is the stock draw.io webapp served by lunad at `/drawio` from
   `{data_dir}/drawio`, loaded in a same-origin iframe with
   `embed=1&proto=json&stealth=1&noExitBtn=1&saveAndExit=0` (`ui=dark` when
   Luna is in dark mode; `noSaveBtn=1` for view-only opens). `stealth=1`
   disables draw.io's own realtime channel (the one that phones home to
   JGraph). Live editing uses Luna's collab hub instead — the same room
   EuroOffice uses for presence.
3. **If the pack is missing:** the probe is a `GET /drawio/pack.json` marker
   file — without the pack the request falls through to the SPA fallback
   (200 text/html), which the probe rejects. The fullscreen shell then shows
   a "This Luna can't open diagrams" card with Download + Close.
4. The webapp speaks draw.io's embed protocol over `postMessage`
   (`web/src/components/files/diagram/drawioApi.js`): on `init` Luna sends
   `load` with the file contents — raw XML for `.drawio`, a base64 data URI
   for the image-container variants (`xml` accepts SVG/PNG data URIs with
   embedded XML). The editor replies `load` when the document is up.
5. **Live editing:** the `load` message sets `autosave: 1` and
   `diffSync: { patchOnly: true }`. Each local change arrives as an
   `autosave` event carrying a draw.io diff `patch` (and a checksum). Luna
   sends that patch as an opaque collab op (`{kind:"patch", patch, checksum}`)
   on `GET /api/v1/collab/ws` — lunad authenticates peers, numbers extra
   sessions, and fans the payload out without reading it, same as EuroOffice.
   Other open editors apply `{action:"patch", patch}` (no checksum: two
   people editing at once would mismatch even when the structural patch
   landed). Inserts are not safe to apply twice, so a reconnect skips patches
   this client sent and sequence numbers it already applied. View-only
   sessions join the room and apply patches, but they do not send any.
   The fullscreen frame shows the same presence line as EuroOffice
   (`Live · Sam`, `Live · only you`, plus ` · view only` when this session
   cannot edit). While the editor is still opening the line is
   `Opening this diagram…`.
6. **Saving:** Luna debounces dirty state the same way as the text editor
   and EuroOffice (~2s idle, never more than 15s stale, 5s retry backoff).
   Before uploading, this editor asks the room for the save election
   (`save_lock` / `save_end`, 5 minute backstop if the saver disconnects) —
   the same single-uploader rule as EuroOffice's `lunaSaveLock`. A denial
   leaves the diagram dirty so the next tick retries. The upload itself asks
   the editor for the current bytes via `{action:"export"}`: format `xml`
   returns the canonical mxfile XML; `xmlsvg`/`xmlpng` return a data URI
   that's decoded and uploaded. The bytes go back through the normal files
   API (`files/upload?overwrite=1`). Luna then tells the room `saved` and
   answers `{action:"status", modified:false}` to clear the editor's
   modified flag. A peer's save clears shared dirt; edits this client made
   and has not uploaded yet stay dirty.
7. **Shared links:** guests join the same room at
   `GET /s/{token}/collab/ws` (path relative to the share). Only diagram
   files are accepted, so a guest cannot inject ops into a text or office
   room. View links join with `can_write: false`. Password links are checked
   the same way as the rest of the share API; the file fetch runs before the
   socket so the browser can store the proof cookie (a WebSocket request
   cannot set that header itself).
8. The editor's Exit button is hidden — the frame owns close and the
   unsaved-changes guard. `exit` events (e.g. template cancel) still funnel
   through the frame's guarded close. In the editor's own status bar,
   `modified: "unsavedChanges"` on the load message shows "Unsaved changes"
   when the diagram is dirty.

## Installing the pack (required to edit)

draw.io is Apache-2.0. LibreServ does **not** ship the webapp in git.

```bash
cd luna
make drawio          # fetch draw.war + extract into luna/dev/drawio
# Restart lunad so it mounts the /drawio route (wired at boot)
```

`drawio` wraps `scripts/install-drawio-assets.sh`; `LUNA_DATA_DIR` defaults
to `luna/dev`, `DRAWIO_VERSION` pins the jgraph/drawio release (default
v31.5.2), `DRAWIO_URL` overrides the download, and `DRAWIO_SHA256`
optionally verifies the war (the release doesn't publish checksums).

What the script produces under `{data_dir}/drawio`:

```text
index.html + js/ + mxgraph/ + stencils/ + templates/ + img/ + …
                                 the complete static webapp (~150 MB)
pack.json                        luna-drawio marker the web UI probes
NOTICE.luna.txt                  attribution (the pack can ship in the ISO)
```

The war's `WEB-INF/` and `META-INF/` (Java server classes Luna never runs)
are excluded during extraction.

## Shipping the pack (install ISO)

`make drawio-pack` (or `scripts/build-drawio-pack.sh`) produces
`os/dist/drawio-pack.tar.zst` — the whole pack as a self-describing `drawio/`
dir. `build-iso.sh` builds it automatically when missing,
`stage-debian-live.sh` stages it next to the rootfs tarball on the ISO, and
`rapidinstall.sh` verifies its sha256 and extracts it onto `LUNA_DATA` — so
diagram editing works on first boot with no download. A device installed
without the pack shows the normal "not installed" card on diagram files.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /drawio/**` | Static webapp pack via one wildcard route — mounted at boot only when `{data_dir}/drawio` exists |
| `GET /api/v1/collab/ws` | Member collab room (presence, opaque diff patches, save election) — the same endpoint EuroOffice uses |
| `GET /s/{token}/collab/ws` | Guest collab room for a shared diagram. Refuses anything that is not a `.drawio` / `.drawio.svg` / `.drawio.png` file |

There is no diagram-only socket and no bundle dir. The file on the drive is
the document; the collab room only carries live patches and who is here.
Vite dev proxies `/drawio` to lunad (see `web/vite.config.js`).

## Creating blank diagrams

"New diagram" writes `BLANK_DRAWIO_XML` from `web/src/lib/diagramFile.js` —
a valid empty `mxfile` — through the same create-file path as the other New
menu kinds, then opens it in the editor.

## Licensing

draw.io is Apache-2.0 — no source-offer obligations like EuroOffice's AGPL,
but keep the attribution (`NOTICE.luna.txt`, pack `LICENSE` files) intact
when redistributing. See the **About → Open source licenses** card in
Settings.
