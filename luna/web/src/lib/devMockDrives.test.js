import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMockUnknownDrive,
  mockInspectResult,
  mockUnknownPssd,
  shouldShowMockUnknownDrive,
  withDevMockDetected,
} from "./devMockDrives.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.removeItem("luna.mockUnknownDrive");
  vi.unstubAllEnvs();
});

describe("devMockDrives", () => {
  it("builds a ~64GB PSSD fixture", () => {
    const drive = mockUnknownPssd();
    expect(drive.model).toBe("64GB PSSD");
    expect(drive.size_bytes).toBe(64_000_000_000);
    expect(isMockUnknownDrive(drive.name)).toBe(true);
    expect(mockInspectResult().writable).toBe(true);
  });

  it("stays off in Vitest by default so empty-state tests keep working", () => {
    expect(shouldShowMockUnknownDrive()).toBe(false);
    expect(withDevMockDetected([])).toEqual([]);
  });

  it("opts in via query param even in test mode", () => {
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    expect(shouldShowMockUnknownDrive()).toBe(true);
    expect(withDevMockDetected([])).toEqual([mockUnknownPssd()]);
  });

  it("opts out via query param", () => {
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=0");
    window.localStorage.setItem("luna.mockUnknownDrive", "1");
    expect(shouldShowMockUnknownDrive()).toBe(false);
  });

  it("never replaces real detected drives", () => {
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    const real = [{ name: "sdb", model: "Real Stick", size_bytes: 8_000_000_000 }];
    expect(withDevMockDetected(real)).toEqual(real);
  });

  it("never injects in production builds", () => {
    // MODE=production is the durable signal; PROD may already be false under Vitest.
    vi.stubEnv("MODE", "production");
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    expect(shouldShowMockUnknownDrive()).toBe(false);
  });
});
