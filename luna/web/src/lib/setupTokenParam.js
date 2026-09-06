/** Query param Connect puts on Luna `/setup` so the device-token step can be skipped. */
export const SETUP_TOKEN_PARAM = "token";

/** sessionStorage key for a Connect handoff token after it is stripped from the URL. */
export const SETUP_HANDOFF_TOKEN_KEY = "luna.setupHandoffToken";

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

/**
 * Stash the Connect handoff token so AccountStep can use it after `/setup?token=`
 * is stripped from the URL (so a refresh mid-wizard does not re-trigger a restart).
 * @param {string} token
 */
export function stashSetupHandoffToken(token) {
  const value = String(token || "").trim();
  if (!value || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SETUP_HANDOFF_TOKEN_KEY, value);
  } catch {
    /* private mode / quota — AccountStep may still read from the URL if present */
  }
}

/**
 * @returns {string}
 */
export function peekSetupHandoffToken() {
  if (typeof sessionStorage === "undefined") return "";
  try {
    return (sessionStorage.getItem(SETUP_HANDOFF_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function clearSetupHandoffToken() {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(SETUP_HANDOFF_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * If `search` has ?token=, stash it and return the token plus a flag that this
 * load came from a fresh Connect link (caller should start the wizard at Welcome).
 *
 * @param {string | URLSearchParams | null | undefined} search
 * @returns {{ token: string, freshFromUrl: boolean }}
 */
export function takeSetupHandoffFromSearch(search) {
  const token = readSetupTokenFromSearch(search);
  if (!token) {
    return { token: peekSetupHandoffToken(), freshFromUrl: false };
  }
  stashSetupHandoffToken(token);
  return { token, freshFromUrl: true };
}
