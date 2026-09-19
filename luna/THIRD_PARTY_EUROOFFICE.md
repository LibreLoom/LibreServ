# Third-party: EuroOffice

EuroOffice is an AGPL-3.0-licensed office suite by the Euro-Office
contributors (derived from ONLYOFFICE, © Ascensio System SIA). Luna can
**optionally** load EuroOffice static web assets from
`{data_dir}/eurooffice` and serve them at `/eurooffice`.

License: GNU Affero General Public License v3.0 —
<https://www.gnu.org/licenses/agpl-3.0.html>

## Not shipped in this repository

This git tree does **not** include EuroOffice binaries, WASM, fonts, or
web-apps. Without that pack, Luna will not edit office files in-app — users can
still download them.

## If you redistribute EuroOffice with Luna

You must:

1. Keep AGPL-3.0 notices with the assets.
2. Offer Corresponding Source for the EuroOffice version you ship. The asset
   pack Luna serves (`web-apps`, `sdkjs`, `fonts`, `dictionaries`) comes from
   these upstream repos — pin the tag matching the image you extracted
   (`EUROOFFICE_IMAGE`, default `ghcr.io/euro-office/documentserver`):
   - https://github.com/Euro-Office/DocumentServer (top-level, aggregates the
     components as submodules)
   - https://github.com/Euro-Office/web-apps
   - https://github.com/Euro-Office/sdkjs
   - https://github.com/Euro-Office/core-fonts
   - https://github.com/Euro-Office/dictionaries
3. Keep attribution with the software. Luna intentionally shows no
   in-product UI credit (the editor chrome names Luna, not EuroOffice);
   attribution lives in this notice, the Luna READMEs, the
   `install-eurooffice-assets.sh` script, and code comments in
   `luna/web/src/components/files/office/`. Keep those notices, and provide
   the license/source information required by AGPL-3.0 however you
   distribute the assets.

Upstream project: https://github.com/Euro-Office (verify the release you use).

## x2t.wasm (browser-side document converter)

The OOXML ↔ `Editor.bin` converter Luna serves at `/eurooffice/x2t/` is
`x2t.wasm`, built by the CryptPad project from ONLYOFFICE core — AGPL-3.0.

- Source: https://github.com/cryptpad/onlyoffice-x2t-wasm
- Prebuilt artifact: GitHub release `x2t.zip` (sha512-verified by
  `scripts/install-eurooffice-assets.sh`; pin via `X2T_VERSION`)

If you redistribute the pack, the same AGPL-3.0 obligations above apply to
x2t.wasm: keep notices, offer the corresponding source (the linked repo +
pinned tag), and keep this file with your distribution.

## Luna’s own code

Luna’s collab relay, file openers, and OOXML create stubs are part of LibreServ /
Luna under this repository’s license — they are not AGPL solely because
EuroOffice can be loaded beside them. The AGPL obligations attach to the
EuroOffice asset pack you install and redistribute.
