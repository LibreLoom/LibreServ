const DEVICE_UID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEVICE_UID_PATTERN = new RegExp(`^[${DEVICE_UID_ALPHABET}]{20}$`);
const VERIFICATION_CODE_PATTERN = /^[0-9A-F]{6}$/;

/** Accept Luna's grouped display form and Crockford's I/L/O lookalikes. */
export function normalizeDeviceUid(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function normalizeVerificationCode(value) {
  return String(value || "").trim().toUpperCase();
}

export function isValidDeviceUid(value) {
  return DEVICE_UID_PATTERN.test(normalizeDeviceUid(value));
}

export function isValidVerificationCode(value) {
  return VERIFICATION_CODE_PATTERN.test(normalizeVerificationCode(value));
}

/** The public Device ID is printed as four groups of four characters. */
export function formatDeviceUid(value) {
  const normalized = normalizeDeviceUid(value);
  if (!DEVICE_UID_PATTERN.test(normalized)) return String(value || "").trim();
  return normalized.match(/.{4}/g).join("-");
}
