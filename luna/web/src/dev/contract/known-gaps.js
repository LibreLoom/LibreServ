/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [
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
  {
    key: "GET /api/v1/connect/status",
    path: "$.cloud_backup",
    reason: "lunad now sends cloud_backup (not_linked / no_payment / ready) in place of card_on_file; the recorded fixture predates it. Remove this and the card_on_file entry after the next full ./ci run -p luna rewrites lunad-responses.json.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.card_on_file",
    reason: "lunad no longer sends card_on_file (replaced by cloud_backup); the recorded fixture predates that. Remove with the cloud_backup entry after the next full ./ci run -p luna.",
  },
  {
    key: "GET /api/v1/drives",
    path: "$[].formatting",
    reason: "lunad sends formatting and format_id only while a drive is being erased (serde skips them otherwise), and the recorded fixture predates the erase rebuild, so it has no key for them. The fake emits them in the Drive erase scenarios. Remove this after the next full ./ci run -p luna rewrites lunad-responses.json.",
  },
  {
    key: "GET /api/v1/drives",
    path: "$[].format_id",
    reason: "lunad sends formatting and format_id only while a drive is being erased (serde skips them otherwise), and the recorded fixture predates the erase rebuild, so it has no key for them. The fake emits them in the Drive erase scenarios. Remove this after the next full ./ci run -p luna rewrites lunad-responses.json.",
  },
  {
    key: "GET /api/v1/drives/detected",
    path: "$[].formatting",
    reason: "lunad sends formatting and format_id only while a drive is being erased (serde skips them otherwise), and the recorded fixture predates the erase rebuild, so it has no key for them. The fake emits them in the Drive erase scenarios. Remove this after the next full ./ci run -p luna rewrites lunad-responses.json.",
  },
  {
    key: "GET /api/v1/drives/detected",
    path: "$[].format_id",
    reason: "lunad sends formatting and format_id only while a drive is being erased (serde skips them otherwise), and the recorded fixture predates the erase rebuild, so it has no key for them. The fake emits them in the Drive erase scenarios. Remove this after the next full ./ci run -p luna rewrites lunad-responses.json.",
  },
];
