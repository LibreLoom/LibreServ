import { describe, expect, it } from "vitest";
import { isPublicLunaHost } from "./publicHost";

describe("isPublicLunaHost", () => {
  it("skips LAN and luna.local", () => {
    expect(isPublicLunaHost("luna.local")).toBe(false);
    expect(isPublicLunaHost("localhost")).toBe(false);
    expect(isPublicLunaHost("192.168.1.20")).toBe(false);
    expect(isPublicLunaHost("127.0.0.1")).toBe(false);
  });

  it("treats the Connect hostname as public", () => {
    expect(isPublicLunaHost("kitchen.luna.servers.libreloom.org")).toBe(true);
  });
});
