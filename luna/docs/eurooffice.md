# EuroOffice on Luna

Luna opens office files in the browser with **EuroOffice only**. There is no
built-in Luna office editor — and no Document Server. The editor runs entirely
client-side; lunad is a thin storage + collaboration relay.

## How it works

1. Opening a supported office file mounts `OfficeEditor` in the fullscreen
   shell immediately — there is no pre-flight probe. Which formats count is
   defined by `OFFICE_FORMATS` in `web/src/lib/fileKinds.js`: every ext there
   is verified by a real `x2t.wasm` conversion in
   `web/src/components/files/office/x2tFormats.test.js` (the api.js
   "supported types" regex advertises ~100 exts, but most of those
   converters aren't in the shipped wasm — doc, csv, pdf, epub, vsdx, iWork,
   WPS and friends all fail or hang, so they're not classified as office at
   all; pdf/epub open in their own modal viewers, csv/tsv in a table preview).
2. Luna mints an office session (`POST /api/v1/office/session` → doc key +
   office token; lunad gates on the same verified list) and loads DocsAPI.
3. **If the pack is missing or the DocsAPI script fails to load:** the
   fullscreen shell shows a "This Luna can't open office files" card with
   Download + Close. A conversion failure shows a similar card naming the
   file in plain language — never the raw `x2t exit N` code.
4. **First opener** downloads the file, converts it to the editor's internal
   `Editor.bin` in a Web Worker with `x2t.wasm`, and uploads the bundle
   (`PUT /api/v1/office/bundle/{key}/Editor.bin`, `origin.<ext>`, `media/*`).
   Joiners find the bundle already on Luna.
5. The editor connects to the docstorage socket
   `/eurooffice/{ver}/doc/{key}/c` — Engine.IO v4 + Socket.IO v5 over
   WebSocket. Lunad authenticates the office token, relays changes/cursors,
   tracks strict-mode block locks, runs the single-saver election, and replays
   the op log to late joiners. It never parses document content.
6. **Saving:** any connected client serializes its live document
   (`asc_nativeGetFile()`), converts `Editor.bin` → the original format with
   the same wasm, uploads through the normal files API, and refreshes the
   bundle. Only formats verified to round-trip through x2t are writable —
   `OFFICE_SAVE_EXT` (docx/dotx/docxf/oform, xlsx/xltx/xlsb, pptx/ppsx/potx,
   odt/ott, ods/ots, odp/otp, rtf). Everything else opens read-only so
   unsaveable edits can't silently vanish — that includes macro-enabled OOXML
   (docm/dotm, xlsm/xltm, pptm/potm/ppsm: x2t writes them but strips the VBA
   project), flat ODF (fodt/fods/fodp: no writer in this build), and legacy
   xls/xlt/ppt/pps (readers exist, writers don't). Autosave runs the
   same path on a debounced dirty-flag timer: ~2s after typing stops, and
   never more than 15s stale while edits continue.
7. **Downloads:** the editor's File → Download menu is patched to use the
   same browser pipeline (nativeGetFile → x2t → blob download) — but only
   for targets this wasm build can actually write (docx/dotx, xlsx/xltx,
   pptx/ppsx, odf, rtf, txt). Menu entries for doc/xls/ppt, csv, html, epub,
   md, the macro formats, and plain "Download" on a view-only source fall
   through to the stock path (no downloadas server exists, so they surface
   the editor's own error). PDF is not
   writable either — File → Print → "Save as PDF" covers that case fully
   client-side.

## Installing the pack (required to edit)

EuroOffice is AGPL-3.0. LibreServ does **not** ship the binaries in git.

```bash
cd luna
make eurooffice        # extract assets + generate fonts + fetch x2t.wasm
# Restart lunad so it mounts the /eurooffice pack routes
```

`eurooffice` wraps `scripts/install-eurooffice-assets.sh`; `LUNA_DATA_DIR`
defaults to `luna/dev`, `EUROOFFICE_IMAGE` overrides the source image,
`X2T_VERSION` pins the converter release (sha512-verified).

What the script produces under `{data_dir}/eurooffice`:

```text
web-apps/            DocsAPI + editor apps (from the image)
sdkjs/               document engine (from the image)
dictionaries/        spellcheck (client-side, no server needed)
core-fonts/          TTFs the wasm converter loads into its filesystem
fonts/               generated font metrics (allfontsgen, one-shot container)
sdkjs/common/AllFonts.js + Images/   generated font index + font-list sprite
                                      (fonts_thumbnail* — the font dropdown
                                      crashes the editor hard on a 404)
x2t/x2t.js + x2t.wasm                browser-side converter (CryptPad build)
fonts-manifest.json                  TTF list the worker fetches
```

## Shipping the pack (install ISO)

`make eurooffice-pack` (or `scripts/build-eurooffice-pack.sh`) produces
`os/dist/eurooffice-pack.tar.zst` — the pack minus `web-apps/*/resources/help`
(~500MB of offline-help PNGs; the Help menu is already hidden via
`customization.help: false`). Everything else ships: every font, all 50
dictionaries. `build-iso.sh` builds it automatically when missing,
`stage-debian-live.sh` stages it next to the rootfs tarball on the ISO, and
`rapidinstall.sh` verifies its sha256 and extracts it onto `LUNA_DATA` — so
office editing works on first boot with no download. Extraction needs `zstd`
in the installer image (in `luna.list.chroot`). A device installed without
the pack shows the normal "not installed" card on office files.

## Endpoints (all cookie-authed except where noted)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/office/session` | Mint doc key + office token; register key → file binding |
| `GET/HEAD/PUT /api/v1/office/bundle/{key}/{*name}` | Converted bundle files (Editor.bin, media/*, origin) |
| `GET /eurooffice/**` | Pack assets via one dispatcher — strips the `9.3.4-<hash>` version segment and upgrades `doc/{key}/c` sockets inside it |
| `GET /sdkjs/**` | Root-level sdkjs alias — the editor iframe resolves `../../sdkjs/` against the root like Document Server's nginx layout |
| `GET /api/v1/collab/ws` | Presence room (existing) |

Bundle dirs live in `{data_dir}/office_bundles/{key}` and are swept at boot
once untouched for a week. The doc key embeds the file's size+mtime, so a
replaced file gets a fresh key, bundle, and room automatically.

## Protocol notes (vs ONLYOFFICE Document Server)

The socket speaks the subset of `DocsCoServer` the pack needs:

- EIO4 `open` → Socket.IO CONNECT (carries `{data:{docid, token, user…}}`) →
  CONNECT-ack → `license` message (developer-mode, edit rights) → client sends
  `auth` → `authChanges` replay + `auth` reply (`participants`, `locks`,
  `settings`, `indexUser`) → `documentOpen` with the bundle url map.
- `saveChanges` appends to the op log and relays wrapped change records;
  `isSaveLock` grants the save election (`saveLock:false` = granted — the
  field is inverted vs the name); `getLock`/`releaseLocks` manage the
  strict-mode block-lock table; `cursor`/`message` fan out in DS's
  `messages` array shape.
- Lock-map keys are the raw block id (`block.guid || block` in DS terms):
  bare strings for word docs, `guid` for excel/present objects. A mutex is
  taken on every `saveChanges` (DS `lockSave`) with a 60s expiry so a dead
  writer cannot starve the room; `unSaveLock` replies to the asker alone
  with `-1` sentinels, and only stays silent while a *live* foreign hold
  exists (DS `unlockSave`: expired holds count as `Empty` and are answered).
- The manual-save election is a separate Luna hold (`lunaSaveLock` /
  `lunaSaveEnd`), not the sdk's `isSaveLock`: the sdk parks its connection
  in `AskSaveChanges` until `unSaveLock` lands and buffers every `askLock`
  meanwhile — holding it across a whole serialize+upload freezes the
  saver's own editor. The election only excludes concurrent
  serialize+uploads; op flushes flow through while someone saves. It is
  released by `lunaSaveEnd`, by the bundle PUT itself, on disconnect, or
  after a 300s backstop TTL.
- `deleteIndex` on `saveChanges`/`unLockDocument` rewinds the op log
  (undo-past-save); `releaseLocks`/`isSave` flags release the sender's
  blocks and save hold. A disconnect broadcasts `releaseLock` for the
  departed user's blocks before `connectState`.
- Rejoin (`auth` with a non-null `sessionId`) is a session *restore*: the
  client's newest seen foreign op is checked (`lastOtherSaveTime` vs the
  log's newest op time) and stale restores get `{type:error, code:4010}`
  so the editor reloads instead of silently diverging. Restores never
  replay `authChanges` (the sdk ignores them); owned `block`s are
  re-granted and peers get a `getLock` refresh. On the client side, coded
  stale drops (4008/4009/4010, or `isCloseCoAuthoring` set without the
  reconnect patch owning it) make EuroOfficeHost remount the whole editor —
  the sdk would otherwise park in permanent view mode, since Luna doesn't
  implement the DS `refreshFile` callback.
- `binaryChanges` is advertised `false`, so ops travel as JSON/base64 strings;
  binary socket.io frames are counted off and dropped (none occur with this
  flag).
- On a refreshed `Editor.bin`, ops the saver had already been sent are dropped
  from the replay log so joiners don't double-apply them.

## Converting adjacent formats

Formats the bundled x2t can't read (csv/tsv, epub, ics, vcf, ipynb, plain
text, markdown, geo files) keep their own previews, but the viewer offers
**Convert & open**: `web/src/lib/officeConvert.js` builds the adjacent OOXML
file in the browser (csv/tsv → xlsx via `xlsxFromRows`; the rest → docx via
`blankDocx`), uploads it next to the original under the first free name
(`name.xlsx`, `name (2).xlsx`, …), and opens it in the editor. The original
file is never touched. pdf and formats with no preview at all (doc, pages,
numbers, key…) get the hint text without the button — no in-browser
converter exists for them.

## Creating blank office files

"New document / spreadsheet / presentation" still creates minimal OOXML stubs
on the drive. Opening them still requires the EuroOffice pack.

## Licensing

Distributors who ship EuroOffice/x2t assets must comply with AGPL-3.0 (source
offer, license notice). See
[`THIRD_PARTY_EUROOFFICE.md`](THIRD_PARTY_EUROOFFICE.md) and the
**About → Open source licenses** card in Settings.
