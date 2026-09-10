# Third-party: EuroOffice

EuroOffice is an AGPL-3.0-licensed office suite (OnlyOffice lineage). Luna can
**optionally** load EuroOffice static web assets from `{data_dir}/eurooffice`
and serve them at `/eurooffice`.

## Not shipped in this repository

This git tree does **not** include EuroOffice binaries, WASM, fonts, or
web-apps. The collaborative office feature works without them via Luna’s
built-in fallback editor.

## If you redistribute EuroOffice with Luna

You must:

1. Keep AGPL-3.0 notices with the assets.
2. Offer Corresponding Source for the EuroOffice version you ship.
3. Show an in-product attribution when the EuroOffice script is loaded
   (see `OfficeEditor` / About).

Upstream project: https://github.com/Euro-Office (verify the release you use).

## Luna’s own code

Luna’s collab relay, fallback editor, file openers, and OOXML stubs are part of
LibreServ / Luna under this repository’s license — they are not AGPL solely
because EuroOffice can be loaded beside them. The AGPL obligations attach to
the EuroOffice asset pack you install and redistribute.
