/**
 * Account password policy — mirrors lunad (`crates/lunad/src/password.rs`)
 * and Sol auth: at least 12 characters, one letter, and one number.
 * Symbols are encouraged for strength UI but are not required.
 */

export const MIN_PASSWORD_LENGTH = 12;

/** Short policy hint (shown as helper copy when the live checklist is hidden). */
export const PASSWORD_POLICY_HINT =
  "At least 12 characters, with a letter and a number";

/** Password field placeholder — same witty nudge as Luna setup. */
export const PASSWORD_FIELD_PLACEHOLDER = 'Not "a1!", please.';

/**
 * @param {string} password
 * @returns {{
 *   hasLength: boolean,
 *   hasLetter: boolean,
 *   hasDigit: boolean,
 *   hasSpecial: boolean,
 *   score: number,
 *   ok: boolean,
 * }}
 */
export function passwordChecks(password, { lengthUnit = "characters" } = {}) {
  const pw = password || "";
  const length = lengthUnit === "utf8-bytes" ? new TextEncoder().encode(pw).length : pw.length;
  const hasLength = length >= MIN_PASSWORD_LENGTH;
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>[\]\\;'`~\-_=+]/.test(pw);
  const score = [hasLength, hasLetter, hasDigit, hasSpecial].filter(Boolean).length;
  return {
    hasLength,
    hasLetter,
    hasDigit,
    hasSpecial,
    score,
    ok: hasLength && hasLetter && hasDigit,
  };
}

/**
 * Plain-language error matching lunad messages, or null when the password is OK.
 * @param {string} password
 * @returns {string | null}
 */
export function passwordPolicyError(password, options) {
  if (!password) return "Enter a password.";
  const { hasLength, hasLetter, hasDigit } = passwordChecks(password, options);
  if (!hasLength) return "Passwords need at least 12 characters.";
  if (!hasLetter || !hasDigit) {
    return "Passwords need at least one letter and one number.";
  }
  return null;
}

/** @param {string} password */
export function meetsPasswordPolicy(password, options) {
  return passwordChecks(password, options).ok;
}
