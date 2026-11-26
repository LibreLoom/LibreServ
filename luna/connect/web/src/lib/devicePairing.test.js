import { describe, expect, it } from "vitest";
import { formatDeviceToken, isValidDeviceToken, normalizeDeviceToken } from "./devicePairing.js";

const TOKEN = "7K4M2Q9XR8N36T5W1PZH";

describe("device token values", () => {
  it("normalizes and groups the device token", () => {
    expect(normalizeDeviceToken(" 7k4m-2q9x r8n3-6t5w-1pzh ")).toBe(TOKEN);
    expect(formatDeviceToken(TOKEN)).toBe("7K4M-2Q9X-R8N3-6T5W-1PZH");
    expect(isValidDeviceToken("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBe(true);
  });

  it("rejects the wrong length and normalizes Crockford look-alike letters", () => {
    expect(isValidDeviceToken("7K4M2Q9XR8N36T5W1PZ")).toBe(false);
    expect(normalizeDeviceToken("7K4M2Q9XR8N36T5W1PZI")).toBe("7K4M2Q9XR8N36T5W1PZ1");
    expect(normalizeDeviceToken("7K4M2Q9XR8N36T5W1PZO")).toBe("7K4M2Q9XR8N36T5W1PZ0");
    expect(isValidDeviceToken("7K4M2Q9XR8N36T5W1PZU")).toBe(false);
  });

  it("leaves an invalid value as typed when formatting", () => {
    expect(formatDeviceToken(" abc ")).toBe("abc");
  });
});
