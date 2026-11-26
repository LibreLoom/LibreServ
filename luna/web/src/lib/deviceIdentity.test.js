import { describe, expect, it } from "vitest";
import { formatDeviceToken, isValidDeviceToken, normalizeDeviceToken } from "./deviceIdentity.js";

describe("device token helpers", () => {
  it("groups a stored ungrouped device token", () => {
    expect(formatDeviceToken("7k4m2q9xr8n36t5w1pzh")).toBe("7K4M-2Q9X-R8N3-6T5W-1PZH");
  });

  it("leaves missing or malformed values alone", () => {
    expect(formatDeviceToken("")).toBe("");
    expect(formatDeviceToken("not-a-token")).toBe("not-a-token");
  });

  it("normalizes grouping, case and lookalike letters", () => {
    expect(normalizeDeviceToken(" 7k4m-2q9x r8n3-6t5w-1pzh ")).toBe("7K4M2Q9XR8N36T5W1PZH");
    expect(normalizeDeviceToken("7K4M2Q9XR8N36T5W1PZI")).toBe("7K4M2Q9XR8N36T5W1PZ1");
    expect(isValidDeviceToken("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBe(true);
    expect(isValidDeviceToken("7K4M2Q9XR8N36T5W1PZU")).toBe(false);
    expect(isValidDeviceToken("7K4M2Q9X")).toBe(false);
  });
});
