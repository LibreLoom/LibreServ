export const SETUP_TOKEN_PARAM = "token";

function paramsFromHash(hash) {
  // Only a fragment can carry the token. URLSearchParams strips a leading
  // "?" too, so without this check a query string would look like a fragment.
  const text = String(hash || "");
  return new URLSearchParams(text.startsWith("#") ? text.slice(1) : "");
}

export function hasSetupTokenInHash(hash) {
  return paramsFromHash(hash).has(SETUP_TOKEN_PARAM);
}

/** Read the device token Connect puts in the `/setup#token=` fragment. */
export function readSetupTokenFromHash(hash) {
  return (paramsFromHash(hash).get(SETUP_TOKEN_PARAM) || "").trim();
}

/** Return the fragment without the token, preserving any unrelated values. */
export function stripSetupTokenFromHash(hash) {
  const params = paramsFromHash(hash);
  params.delete(SETUP_TOKEN_PARAM);
  const next = params.toString();
  return next ? `#${next}` : "";
}
