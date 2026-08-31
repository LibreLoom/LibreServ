/**
 * Account password policy — mirrors luna-connect/internal/auth/password.go
 * and LibreServ/Luna: at least 12 characters, one letter, and one number.
 * Symbols are encouraged for strength UI but are not required.
 */

export const MIN_PASSWORD_LENGTH = 12;

/** Short helper under the password field on registration. */
export const PASSWORD_POLICY_HELPER =
  "Use at least 12 characters, including a letter and a number.";

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

/** @param {string} password */
export function meetsPasswordPolicy(password) {
  return passwordChecks(password).ok;
}
