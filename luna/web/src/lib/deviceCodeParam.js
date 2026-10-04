/** Query param Connect puts on Luna `/setup` so the device-token step can be skipped. */
export const SETUP_TOKEN_PARAM = "token";

/**
 * @param {string | URLSearchParams | null | undefined} search
 * @returns {string}
 */
export function readSetupTokenFromSearch(search) {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  return (params.get(SETUP_TOKEN_PARAM) || "").trim();
}

/**
 * Returns a copy of `search` without the setup token param.
 * @param {string | URLSearchParams | null | undefined} search
 * @returns {URLSearchParams}
 */
export function stripSetupTokenFromSearch(search) {
  const params =
    search instanceof URLSearchParams
      ? new URLSearchParams(search)
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  params.delete(SETUP_TOKEN_PARAM);
  return params;
}
