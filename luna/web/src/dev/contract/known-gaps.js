/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [
  {
    key: "GET /api/v1/system/health/check",
    path: "$.checks.search_inside.details",
    reason: "The CI container that records lunad's responses has no pdftotext or tesseract, so lunad reports search_inside as a warning (with details and more); the fake shows the OS image, where both are installed and the row passes.",
  },
  {
    key: "GET /api/v1/system/health/check",
    path: "$.checks.search_inside.more",
    reason: "Same as search_inside.details: the recording container lacks the PDF and OCR tools the OS image ships.",
  },
  {
    key: "GET /api/v1/system/health/check",
    path: "$.checks.network.more",
    reason: "The dashboard/no-internet scenario seeds a warning on checks.network with `more` (user-facing detail: check that the router or modem is online) so the header pill agrees with the Needs you row. The fixture records a passing network check, whose shape has no `more` — other checks carry an optional `more?`, but network's recorded row does not.",
  },
  {
    key: "GET /api/v1/backups",
    path: "$[].can_resume",
    reason: "lunad added can_resume (paused backups rebuilt from a drive) after lunad-responses.json was last recorded. Remove this once a full ./ci run -p luna rewrites the fixture.",
  },
  {
    key: "GET /api/v1/backups",
    path: "$[].waiting_reason",
    reason: "lunad's shared protection_json (api/backups.rs) sends a waiting_reason on every backup row; the recorded fixture predates that key. The fake exposes it so the 24-hour needs-a-look timer in lib/backupRows.js (needsALook) can be exercised in scenarios.",
  },
  {
    key: "GET /api/v1/backups",
    path: "$[].waiting_since",
    reason: "Same shared protection_json as waiting_reason: lunad sends waiting_since so a long-waiting backup gets a Needs you row, but the fixture was recorded before it. The fake sets it to exercise that timer.",
  },
  {
    key: "GET /api/v1/cloud/backups",
    path: "$[].paused",
    reason: "protection_json (api/backups.rs) flags paused: \"locked\" on cloud backups whose source or backup drive is locked; the fixture was recorded before the flag existed. The fake needs it for isPausedByLock in lib/backupRows.js.",
  },
  {
    key: "GET /api/v1/cloud/backups",
    path: "$[].locked_drive_names",
    reason: "The same protection_json adds locked_drive_names (the locked drives' labels) beside paused, so the UI can say which drives to unlock. Absent from the stale fixture; the fake uses it for the lock-pause notice.",
  },
  {
    key: "GET /api/v1/cloud/backups",
    path: "$[].waiting_reason",
    reason: "protection_json sends waiting_reason on cloud rows as well (e.g. a locked drive or a full quota); lunad-responses.json predates it. The fake needs it so backupWaitingReason in lib/backupRows.js has a reason to show.",
  },
  {
    key: "GET /api/v1/cloud/backups",
    path: "$[].waiting_since",
    reason: "Same as cloud waiting_reason: lunad pairs it with waiting_since, which the fixture lacks. The fake emits it to drive the 24-hour needs-a-look check in lib/backupRows.js.",
  },
  {
    key: "GET /api/v1/forms/responses",
    path: "$.total",
    reason: "lunad's paged Responses list (api/forms.rs) returns total alongside responses, but the fixture was recorded before SQLite paging landed. The fake sends it so the Responses page can paginate.",
  },
  {
    key: "GET /api/v1/forms/responses",
    path: "$.next_offset",
    reason: "The paged Responses list returns next_offset (null on the last page); the recorded shape predates it. The fake uses it for the load-more link.",
  },
  {
    key: "GET /api/v1/forms/responses",
    path: "$.revision",
    reason: "The paged Responses list returns the current form revision so an open editor cannot save over newer answers; the fixture predates it. The fake sends it so revision changes can be shown.",
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
