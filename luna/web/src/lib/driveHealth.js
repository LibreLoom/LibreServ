/**
 * Turn SMART-ish API fields into plain drive-health copy.
 * Never expose smartctl jargon.
 * Returns null when the drive has no health report — callers should omit the pill.
 *
 * @param {null | { available?: boolean, overall?: string, temperature_c?: number | null, reallocated_sectors?: number | null }} health
 * @returns {null | { pill: string, title: string, detail: string }}
 */
export function describeDriveHealth(health) {
  if (!health) {
    return {
      pill: "muted",
      title: "Checking…",
      detail: "Checking this hard drive for wear.",
    };
  }
  if (!health.available) {
    return null;
  }

  const temp =
    health.temperature_c == null
      ? ""
      : ` It's about ${health.temperature_c}°C.`;
  const worn = (health.reallocated_sectors || 0) > 0;
  const passed = health.overall === "passed";

  if (passed && !worn) {
    return {
      pill: "success",
      title: "Healthy",
      detail: `This drive reported no problems.${temp}`,
    };
  }
  if (passed && worn) {
    return {
      pill: "warning",
      title: "Working, with a warning",
      detail: `This drive is still working, but it has repaired a few worn spots. Copy important files off it soon.${temp}`,
    };
  }
  return {
    pill: "error",
    title: "This drive needs attention",
    detail: `The drive reported a problem. Copy your files somewhere else and don't use it for new photos.${temp}`,
  };
}
