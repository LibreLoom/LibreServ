const DEVICE_TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/** Ungrouped, uppercase, lookalike letters folded the way Luna and Connect compare. */
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

/** Groups of four for display: 7K4M-2Q9X-R8N3-6T5W-1PZH. */
export function formatDeviceToken(value) {
  const normalized = normalizeDeviceToken(value);
  if (!DEVICE_TOKEN_PATTERN.test(normalized)) return String(value || "").trim();
  return normalized.match(/.{4}/g).join("-");
}
