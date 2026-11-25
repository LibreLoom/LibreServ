export const SETUP_GRANT_PARAM = "setup_grant";

function paramsFromHash(hash) {
  return new URLSearchParams(String(hash || "").replace(/^#/, ""));
}

export function hasSetupGrantInHash(hash) {
  return paramsFromHash(hash).has(SETUP_GRANT_PARAM);
}

/** Read the one-time setup grant Connect puts in the `/setup` fragment. */
export function readSetupGrantFromHash(hash) {
  return (paramsFromHash(hash).get(SETUP_GRANT_PARAM) || "").trim();
}

/** Return the fragment without the grant, preserving any unrelated values. */
export function stripSetupGrantFromHash(hash) {
  const params = paramsFromHash(hash);
  params.delete(SETUP_GRANT_PARAM);
  const next = params.toString();
  return next ? `#${next}` : "";
}
