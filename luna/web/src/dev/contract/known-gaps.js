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
    key: "GET /api/v1/connect/status",
    path: "$.connect_error",
    reason: "The generated fixture predates device auth; lunad now reports connection and pairing errors as connect_error. Remove this once a full ./ci run -p luna records the new response shape.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.device_uid",
    reason: "The generated fixture predates device-token pairing; lunad no longer reports a device_uid, and the fake never does. Remove this once a full ./ci run -p luna records the new response shape.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.verification_code",
    reason: "The generated fixture predates device-token pairing; lunad no longer reports a verification_code, and the fake never does. Remove this once a full ./ci run -p luna records the new response shape.",
  },
  {
    key: "GET /api/v1/connect/status",
    path: "$.device_token_set",
    reason: "New in device-token pairing: lunad says whether a device token is saved. The generated fixture predates it. Remove this once a full ./ci run -p luna records the new response shape.",
  },
];
