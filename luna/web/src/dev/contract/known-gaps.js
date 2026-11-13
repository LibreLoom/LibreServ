/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [
  {
    key: "GET /api/v1/drives",
    path: "$[].converting",
    reason: "The recorded fixture predates removal of drive conversion; lunad and the fake no longer return this field. Remove this entry when the fixture is regenerated.",
  },
  {
    key: "GET /api/v1/drives",
    path: "$[].encrypted",
    reason: "The recorded drive-list fixture predates removal of drive encryption; lunad and the fake no longer return this field. Remove this entry when the fixture is regenerated.",
  },
  {
    key: "GET /api/v1/drives",
    path: "$[].locked",
    reason: "The recorded drive-list fixture predates removal of drive encryption; lunad and the fake no longer return this field. Remove this entry when the fixture is regenerated.",
  },
  {
    key: "GET /api/v1/system/health/check",
    path: "$.checks.erase_tools",
    reason: "The recorded fixture predates removal of the erase-tools check from lunad and the fake. Remove this entry when the fixture is regenerated.",
  },
  {
    key: "GET /api/v1/cloud/restore-private/records/{}",
    path: "*",
    reason: "The recorder has no caller-owned signed Connect records for this route; private record authorization and pagination are covered by lunad API tests and disposable-provider browser fixtures.",
  },
  {
    key: "GET /api/v1/cloud/restore-private/records/{}/names",
    path: "*",
    reason: "The recorder has no caller-owned signed Connect records for this route; private record authorization and pagination are covered by lunad API tests and disposable-provider browser fixtures.",
  },
  {
    key: "GET /api/v1/cloud/restore-private/records/{}/{}",
    path: "*",
    reason: "The recorder has no caller-owned signed Connect records for this route; private record authorization and pagination are covered by lunad API tests and disposable-provider browser fixtures.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.device_token_error",
    reason: "lunad sends device_token_error only when the saved token is unusable (serde skips None), and no lunad API test records that state, so the fixture has no key for it. The fake emits it for the dashboard's Needs you row (lib/needsYou.js). Remove this once a lunad test GETs /connect/status with a rejected token.",
  },
];
