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
   Luna is in dark mode; `noSaveBtn=1` for read-only opens). `stealth=1`
   disables draw.io's realtime sync channel, so nothing leaves the device.
3. **If the pack is missing:** the probe is a `GET /drawio/pack.json` marker
   file — without the pack the request falls through to the SPA fallback
   (200 text/html), which the probe rejects. The fullscreen shell then shows
   a "This Luna can't open diagrams" card with Download + Close.
4. The webapp speaks draw.io's embed protocol over `postMessage`
   (`web/src/components/files/diagram/drawioApi.js`): on `init` Luna sends
   `load` with the file contents — raw XML for `.drawio`, a base64 data URI
   for the image-container variants (`xml` accepts SVG/PNG data URIs with
   embedded XML). The editor replies `load` when the document is up.
5. **Saving:** `autosave=1` makes the editor emit `autosave` events on every
   change; Luna debounces them (same cadence as the text editor: ~2s idle,
   never more than 15s stale, 5s retry backoff). A save — from the debounced
   autosave, the frame's Save button, or the editor's own Save button — asks
   the editor for the current bytes via `{action:"export"}`: format `xml`
   returns the canonical mxfile XML; `xmlsvg`/`xmlpng` return a data URI
   that's decoded and uploaded. The bytes go back through the normal files
   API (`files/upload?overwrite=1`), then Luna answers
   `{action:"status", modified:false}` to clear the editor's modified flag.
6. The editor's Exit button is hidden — the frame owns close and the
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

No session endpoint, no socket, no bundle dir — the file on the drive is
the whole state. Vite dev proxies `/drawio` to lunad (see
`web/vite.config.js`).

## Creating blank diagrams

"New diagram" writes `BLANK_DRAWIO_XML` from `web/src/lib/diagramFile.js` —
a valid empty `mxfile` — through the same create-file path as the other New
menu kinds, then opens it in the editor.

## Licensing

draw.io is Apache-2.0 — no source-offer obligations like EuroOffice's AGPL,
but keep the attribution (`NOTICE.luna.txt`, pack `LICENSE` files) intact
when redistributing. See the **About → Open source licenses** card in
Settings.
