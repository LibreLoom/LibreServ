import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_UNKNOWN_PSSD_NAME } from "./devMockDrives.js";
import { isPresentDrive, isWritableDrive, releaseInspectedDrive } from "./drives.js";

afterEach(() => vi.unstubAllGlobals());

describe("drive state predicates", () => {
  it("treats missing, ejected and failed drives as absent", () => {
    for (const state of ["missing", "ejected", "failed"]) {
      expect(isPresentDrive({ state })).toBe(false);
      expect(isWritableDrive({ state })).toBe(false);
    }
    expect(isPresentDrive({ state: "ready" })).toBe(true);
  });

  it("treats read-only drives as present but not writable", () => {
    expect(isPresentDrive({ state: "readonly" })).toBe(true);
    expect(isWritableDrive({ state: "readonly" })).toBe(false);
    expect(isWritableDrive({ state: "ready" })).toBe(true);
  });
});

describe("releaseInspectedDrive", () => {
  it("posts to the release route for the device", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await releaseInspectedDrive({ name: "sdb1" });
    const [url, init] = /** @type {any} */ (fetchMock.mock.calls[0]);
    expect(String(url)).toContain("/api/v1/drives/sdb1/release");
    expect(init.method).toBe("POST");
  });

  it("does nothing without a drive or for the demo drive", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await releaseInspectedDrive(null);
    await releaseInspectedDrive({ name: MOCK_UNKNOWN_PSSD_NAME });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a failure through instead of hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })));
    await expect(releaseInspectedDrive({ name: "sdb1" })).rejects.toThrow();
  });
});
