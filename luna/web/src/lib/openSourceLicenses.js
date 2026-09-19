/**
 * Registry of third-party components Luna serves or vendors, shown under
 * Settings → About → Luna → Open source licenses. Each entry needs a plain
 * `what` line (users aren't lawyers), the license name, and either a
 * bundled `licenseFile` under web/public/licenses/ or a `licenseUrl` to
 * open. Add one entry per vendored component — not one per license; two
 * components can share the same license file.
 */

/** @typedef {object} LicenseEntry
 * @property {string} id stable key
 * @property {string} name component name
 * @property {string} what what it does for the user, in plain language
 * @property {string} license short license name, e.g. "AGPL-3.0"
 * @property {string} [licenseFile] bundled text path, e.g. "/licenses/agpl-3.0.txt"
 * @property {string} [licenseUrl] canonical license link when no file is bundled
 * @property {string} copyright who owns it
 * @property {string} source where the source code lives
 * @property {string} [notices] where in-pack notices live, if any
 */

/** @type {LicenseEntry[]} */
export const OPEN_SOURCE_LICENSES = [
  {
    id: "eurooffice",
    name: "EuroOffice",
    what: "The document, spreadsheet, and presentation editor that runs in your browser when you open office files.",
    license: "AGPL-3.0",
    licenseFile: "/licenses/agpl-3.0.txt",
    copyright:
      "Euro-Office contributors — derived from ONLYOFFICE, © Ascensio System SIA",
    source: "https://github.com/Euro-Office/DocumentServer",
    notices: "License and notice files also ship inside the pack at /eurooffice.",
  },
  {
    id: "x2t-wasm",
    name: "x2t.wasm",
    what: "Converts office documents between formats — also in your browser, so files never leave this Luna.",
    license: "AGPL-3.0",
    licenseFile: "/licenses/agpl-3.0.txt",
    copyright: "ONLYOFFICE core; WebAssembly build by the CryptPad project",
    source: "https://github.com/cryptpad/onlyoffice-x2t-wasm",
  },
];
