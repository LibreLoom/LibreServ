/**
 * Account password policy — mirrors lunad (`crates/lunad/src/password.rs`)
 * and LibreServ auth: at least 12 characters, one letter, and one number.
 * Symbols are encouraged for strength UI but are not required.
 */

export const MIN_PASSWORD_LENGTH = 12;

/** Placeholder / short hint for password fields. */
export const PASSWORD_POLICY_HINT =
  "At least 12 characters, with a letter and a number";

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
export function passwordChecks(password) {
  const pw = password || "";
  const hasLength = pw.length >= MIN_PASSWORD_LENGTH;
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
export function passwordPolicyError(password) {
  if (!password) return "Enter a password.";
  const { hasLength, hasLetter, hasDigit } = passwordChecks(password);
  if (!hasLength) return "Passwords need at least 12 characters.";
  if (!hasLetter || !hasDigit) {
    return "Passwords need at least one letter and one number.";
  }
  return null;
}

/** @param {string} password */
export function meetsPasswordPolicy(password) {
  return passwordChecks(password).ok;
}
