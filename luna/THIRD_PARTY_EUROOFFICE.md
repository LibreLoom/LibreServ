# Third-party: EuroOffice

EuroOffice is an AGPL-3.0-licensed office suite (OnlyOffice lineage). Luna can
**optionally** load EuroOffice static web assets from `{data_dir}/eurooffice`
and serve them at `/eurooffice`.

## Not shipped in this repository

This git tree does **not** include EuroOffice binaries, WASM, fonts, or
web-apps. Without that pack, Luna will not edit office files in-app — users can
still download them.

## If you redistribute EuroOffice with Luna

You must:

1. Keep AGPL-3.0 notices with the assets.
2. Offer Corresponding Source for the EuroOffice version you ship.
3. Show in-product attribution when EuroOffice is loaded (see `OfficeEditor` /
   `EuroOfficeHost`).

Upstream project: https://github.com/Euro-Office (verify the release you use).

## Luna’s own code

Luna’s collab relay, file openers, and OOXML create stubs are part of LibreServ /
Luna under this repository’s license — they are not AGPL solely because
EuroOffice can be loaded beside them. The AGPL obligations attach to the
EuroOffice asset pack you install and redistribute.
