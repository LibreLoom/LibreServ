import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useSetupProgress from "./useSetupProgress.js";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import api from "../lib/api";

describe("useSetupProgress", () => {
  it("saves progress via PUT to /setup/progress", async () => {
    vi.mocked(api).mockResolvedValue(/** @type {any} */({ ok: true }));

    const { result } = renderHook(() => useSetupProgress());
    let promise;
    await act(async () => {
      promise = result.current.saveProgress("domain", "input", { domain: "example.com" });
      await promise;
    });

    expect(api).toHaveBeenCalledWith("/setup/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_step: "domain",
        current_sub_step: "input",
        step_data: { domain: "example.com" },
      }),
    });
  });

  it("increments sequence number on each save", async () => {
    vi.mocked(api).mockResolvedValue(/** @type {any} */({ ok: true }));

    const { result } = renderHook(() => useSetupProgress());
    /** @type {{ seq: number } | undefined} */
    let r1;
    /** @type {{ seq: number } | undefined} */
    let r2;
    await act(async () => {
      r1 = await result.current.saveProgress("step1", "", {});
      r2 = await result.current.saveProgress("step2", "", {});
    });

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(/** @type {{ seq: number }} */ (r1).seq).toBeLessThan(/** @type {{ seq: number }} */ (r2).seq);
  });

  it("flushProgress resolves when no in-flight request", async () => {
    const { result } = renderHook(() => useSetupProgress());
    await expect(result.current.flushProgress()).resolves.toBeUndefined();
  });

  it("flushProgress awaits in-flight request", async () => {
    let resolveApi;
    vi.mocked(api).mockReturnValue(new Promise((resolve) => { resolveApi = resolve; }));

    const { result } = renderHook(() => useSetupProgress());
    let savePromise;
    act(() => {
      savePromise = result.current.saveProgress("step1", "", {});
    });

    const flushPromise = result.current.flushProgress();

    await act(async () => {
      resolveApi({ ok: true });
      await savePromise;
    });

    await expect(flushPromise).resolves.toBeUndefined();
  });
});
