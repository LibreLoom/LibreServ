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
