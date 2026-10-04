/** Query param Connect puts on Luna `/setup` so the device-token step can be skipped. */
export const DEVICE_CODE_PARAM = "token";

/**
 * @param {string | URLSearchParams | null | undefined} search
 * @returns {string}
 */
export function readDeviceCodeFromSearch(search) {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  return (params.get(DEVICE_CODE_PARAM) || "").trim();
}

/**
 * Returns a copy of `search` without the device code param.
 * @param {string | URLSearchParams | null | undefined} search
 * @returns {URLSearchParams}
 */
export function stripDeviceCodeFromSearch(search) {
  const params =
    search instanceof URLSearchParams
      ? new URLSearchParams(search)
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  params.delete(DEVICE_CODE_PARAM);
  return params;
}
