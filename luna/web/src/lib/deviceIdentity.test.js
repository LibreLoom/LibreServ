import { describe, expect, it } from "vitest";
import {
  formatDeviceUid,
  isValidDeviceUid,
  isValidVerificationCode,
  normalizeDeviceUid,
  normalizeVerificationCode,
} from "./deviceIdentity.js";

describe("formatDeviceUid", () => {
  it("groups a stored ungrouped Device ID", () => {
    expect(formatDeviceUid("7k4m2q9xr8n36t5w1pzh")).toBe("7K4M-2Q9X-R8N3-6T5W-1PZH");
  });

  it("leaves missing or malformed values alone", () => {
    expect(formatDeviceUid("")).toBe("");
    expect(formatDeviceUid("not-an-id")).toBe("not-an-id");
  });

  it("validates the values used to restore pairing details", () => {
    expect(normalizeDeviceUid(" 7k4m-2q9x r8n3-6t5w-1pzh ")).toBe("7K4M2Q9XR8N36T5W1PZH");
    expect(isValidDeviceUid("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBe(true);
    expect(normalizeDeviceUid("7K4M2Q9XR8N36T5W1PZI")).toBe("7K4M2Q9XR8N36T5W1PZ1");
    expect(isValidDeviceUid("7K4M2Q9XR8N36T5W1PZU")).toBe(false);
    expect(normalizeVerificationCode(" a3f91c ")).toBe("A3F91C");
    expect(isValidVerificationCode("A3F91C")).toBe(true);
    expect(isValidVerificationCode("A3F91G")).toBe(false);
  });
});
