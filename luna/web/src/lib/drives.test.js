import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("posts to the dismiss route for the device", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await releaseInspectedDrive({ name: "sdb1" });
    const [url, init] = /** @type {any} */ (fetchMock.mock.calls[0]);
    expect(String(url)).toContain("/api/v1/drives/sdb1/dismiss");
    expect(init.method).toBe("POST");
  });

  it("does nothing without a drive and swallows failures", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await releaseInspectedDrive(null);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(releaseInspectedDrive({ name: "sdb1" })).resolves.toBeUndefined();
  });
});
