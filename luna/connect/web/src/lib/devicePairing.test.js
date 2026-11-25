import { describe, expect, it } from "vitest";
import {
  formatDeviceUid,
  isValidDeviceUid,
  isValidVerificationCode,
  normalizeDeviceUid,
  normalizeVerificationCode,
} from "./devicePairing.js";

const UID = "7K4M2Q9XR8N36T5W1PZH";

describe("device pairing values", () => {
  it("normalizes and groups the public Device ID", () => {
    expect(normalizeDeviceUid(" 7k4m-2q9x r8n3-6t5w-1pzh ")).toBe(UID);
    expect(formatDeviceUid(UID)).toBe("7K4M-2Q9X-R8N3-6T5W-1PZH");
    expect(isValidDeviceUid("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBe(true);
  });

  it("rejects the wrong length and normalizes Crockford look-alike letters", () => {
    expect(isValidDeviceUid("7K4M2Q9XR8N36T5W1PZ")).toBe(false);
    expect(normalizeDeviceUid("7K4M2Q9XR8N36T5W1PZI")).toBe("7K4M2Q9XR8N36T5W1PZ1");
    expect(normalizeDeviceUid("7K4M2Q9XR8N36T5W1PZO")).toBe("7K4M2Q9XR8N36T5W1PZ0");
    expect(isValidDeviceUid("7K4M2Q9XR8N36T5W1PZU")).toBe(false);
  });

  it("normalizes and validates the six-character Verification code", () => {
    expect(normalizeVerificationCode(" a3f91c ")).toBe("A3F91C");
    expect(isValidVerificationCode("A3F91C")).toBe(true);
    expect(isValidVerificationCode("A3F91")).toBe(false);
    expect(isValidVerificationCode("A3F91G")).toBe(false);
  });
});
