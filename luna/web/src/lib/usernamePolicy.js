/**
 * Username + display-name rules — mirrors lunad `normalize_username` and
 * register display_name checks in `crates/lunad/src/auth.rs`.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 80;

/** Plain-language rule copy (matches lunad AuthError::BadUsername). */
export const USERNAME_POLICY_HINT =
  "Usernames are 3-32 letters, numbers, dots, dashes, or underscores.";

const USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * @param {string} username
 * @returns {boolean}
 */
export function isValidUsername(username) {
  const value = String(username || "").trim().toLowerCase();
  return (
    value.length >= USERNAME_MIN &&
    value.length <= USERNAME_MAX &&
    USERNAME_RE.test(value)
  );
}

/**
 * @param {string} username
 * @returns {string | null} Error message, or null when empty/valid.
 */
export function usernamePolicyError(username) {
  const value = String(username || "").trim();
  if (!value) return null;
  if (!isValidUsername(value)) return USERNAME_POLICY_HINT;
  return null;
}

/**
 * Display name is optional in setup (falls back to username). When provided,
 * lunad requires 1–80 characters after trim.
 *
 * @param {string} displayName
 * @returns {boolean}
 */
export function isValidDisplayName(displayName) {
  const value = String(displayName || "").trim();
  return value.length === 0 || value.length <= DISPLAY_NAME_MAX;
}

/**
 * @param {string} displayName
 * @returns {string | null}
 */
export function displayNamePolicyError(displayName) {
  const value = String(displayName || "").trim();
  if (!value) return null;
  if (value.length > DISPLAY_NAME_MAX) {
    return `Names can be up to ${DISPLAY_NAME_MAX} characters.`;
  }
  return null;
}
