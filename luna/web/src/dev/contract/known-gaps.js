/** Known, intentional or not-yet-fixed differences. key = normalized ("GET /api/v1/drives/{}/backups/{}/versions"),
 *  path = JSON path from the failure message ("$[].current") or "*" for the whole route. Remove an entry when fixed. */
/** @type {{ key: string, path: string, reason: string }[]} */
export const KNOWN_GAPS = [
  {
    key: "POST /api/v1/drives/{}/inspect",
    path: "*",
    reason: "The fake registers GET but the app sends POST (FilesPage.jsx), so the fake answers 501 (plan item 1.8, finding 8, luna/docs/states-feedback/plan.md).",
  },
  {
    key: "GET /api/v1/drives/{}/inspect",
    path: "*",
    reason: "Same drift seen from the GET side: lunad only has POST for inspect, the fake has only GET (plan item 1.8, finding 8, luna/docs/states-feedback/plan.md).",
  },
];
