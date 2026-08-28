import { describe, expect, it } from "vitest";
import { describeDriveHealth } from "./driveHealth";

describe("describeDriveHealth", () => {
  it("stays quiet when a health report is unavailable", () => {
    const copy = describeDriveHealth({ available: false, overall: "unknown" });
    expect(copy).toBeNull();
  });

  it("glosses a healthy drive with temperature", () => {
    const copy = describeDriveHealth({
      available: true,
      overall: "passed",
      temperature_c: 31,
      reallocated_sectors: 0,
    });
    expect(copy.pill).toBe("success");
    expect(copy.detail).toMatch(/31°C/);
    expect(copy.detail.toLowerCase()).not.toMatch(/smart/);
  });

  it("warns without jargon when the disk has repaired spots", () => {
    const copy = describeDriveHealth({
      available: true,
      overall: "passed",
      temperature_c: 40,
      reallocated_sectors: 12,
    });
    expect(copy.pill).toBe("warning");
    expect(copy.detail).toMatch(/worn spots/i);
  });
});
