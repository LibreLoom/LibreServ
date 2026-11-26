const DEVICE_TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEVICE_TOKEN_PATTERN = new RegExp(`^[${DEVICE_TOKEN_ALPHABET}]{20}$`);

/** Accept the grouped display form, any case, and Crockford's I/L/O lookalikes. */
export function normalizeDeviceToken(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function isValidDeviceToken(value) {
  return DEVICE_TOKEN_PATTERN.test(normalizeDeviceToken(value));
}

/** The device token is shown as four groups of four characters. */
export function formatDeviceToken(value) {
  const normalized = normalizeDeviceToken(value);
  if (!DEVICE_TOKEN_PATTERN.test(normalized)) return String(value || "").trim();
  return normalized.match(/.{4}/g).join("-");
}
