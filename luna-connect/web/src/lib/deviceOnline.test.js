import { describe, expect, it, vi } from "vitest";

import {
  DEVICE_ONLINE_POLL_MS,
  fetchDeviceOnline,
  fetchDeviceSetupReadiness,
  fetchDeviceSetupReady,
} from "./deviceOnline.js";

describe("fetchDeviceOnline", () => {
  it("returns true when the bound device is online", async () => {
    const api = vi.fn(async () => ({
      devices: [
        { id: "dev_1", online: true },
        { id: "dev_2", online: false },
      ],
    }));
    await expect(fetchDeviceOnline(api, "dev_1")).resolves.toBe(true);
    expect(api).toHaveBeenCalledWith("/api/v1/account/devices");
  });

  it("returns false when the bound device is offline", async () => {
    const api = vi.fn(async () => ({
      devices: [{ id: "dev_1", online: false }],
    }));
    await expect(fetchDeviceOnline(api, "dev_1")).resolves.toBe(false);
  });

  it("falls back to the first device when no id is passed", async () => {
    const api = vi.fn(async () => ({
      devices: [{ id: "dev_1", online: true }],
    }));
    await expect(fetchDeviceOnline(api)).resolves.toBe(true);
  });
});

describe("fetchDeviceSetupReadiness", () => {
  it("returns full readiness breakdown", async () => {
    const api = vi.fn(async () => ({
      online: true,
      has_tunnel: true,
      reachable: false,
      hostname: "test.luna.servers.libreloom.org",
      ready: false,
    }));
    const result = await fetchDeviceSetupReadiness(api, "dev_1");
    expect(result).toEqual({
      online: true,
      has_tunnel: true,
      reachable: false,
      hostname: "test.luna.servers.libreloom.org",
      ready: false,
    });
    expect(api).toHaveBeenCalledWith("/api/v1/account/devices/dev_1/setup-readiness");
  });

  it("returns all false when without a device id", async () => {
    const api = vi.fn();
    const result = await fetchDeviceSetupReadiness(api, "");
    expect(result).toEqual({
      online: false,
      has_tunnel: false,
      reachable: false,
      hostname: "",
      ready: false,
    });
    expect(api).not.toHaveBeenCalled();
  });
});

describe("fetchDeviceSetupReady", () => {
  it("returns true when setup-readiness reports ready", async () => {
    const api = vi.fn(async (path) => {
      if (path.includes("setup-readiness")) {
        return { ready: true, online: true, has_tunnel: true, reachable: true };
      }
      return {};
    });
    await expect(fetchDeviceSetupReady(api, "dev_1")).resolves.toBe(true);
    expect(api).toHaveBeenCalledWith("/api/v1/account/devices/dev_1/setup-readiness");
  });

  it("returns false when setup-readiness is not ready", async () => {
    const api = vi.fn(async () => ({ ready: false, online: true, has_tunnel: true, reachable: false }));
    await expect(fetchDeviceSetupReady(api, "dev_1")).resolves.toBe(false);
  });

  it("returns false without a device id", async () => {
    const api = vi.fn();
    await expect(fetchDeviceSetupReady(api, "")).resolves.toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("DEVICE_ONLINE_POLL_MS", () => {
  it("polls every five seconds during onboarding wait", () => {
    expect(DEVICE_ONLINE_POLL_MS).toBe(5000);
  });
});
