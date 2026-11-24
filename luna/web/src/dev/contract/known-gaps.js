/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [
  {
    key: "GET /api/v1/system/health/check",
    path: "$.checks.network.more",
    reason: "The dashboard/no-internet scenario seeds a warning on checks.network with `more` (user-facing detail: check that the router or modem is online) so the header pill agrees with the Needs you row. The fixture records a passing network check, whose shape has no `more` — other checks carry an optional `more?`, but network's recorded row does not.",
  },
  {
    key: "GET /api/v1/photos/albums",
    path: "$[].owner_user_id",
    reason: "lunad's album_json (api/photos.rs) returns the full row — including owner_user_id — to managers and a projection without it to other viewers. The fixture recorded the list as a viewer, so its shape lacks the key; the fake includes it for albums the caller owns so PhotosPage's canManageAlbum can show edit/delete actions.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.device_token_error",
    reason: "lunad sends device_token_error only when the saved token is unusable (serde skips None), and no lunad API test records that state, so the fixture has no key for it. The fake emits it for the dashboard's Needs you row (lib/needsYou.js). Remove this once a lunad test GETs /connect/status with a rejected token.",
  },
];
