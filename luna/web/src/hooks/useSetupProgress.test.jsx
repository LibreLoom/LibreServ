import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useSetupProgress from "./useSetupProgress.js";

vi.mock("../lib/api", () => ({
  postJson: vi.fn(),
}));

import { postJson } from "../lib/api";

const mockedPostJson = vi.mocked(postJson);

describe("useSetupProgress", () => {
  beforeEach(() => {
    mockedPostJson.mockReset();
    mockedPostJson.mockResolvedValue({ current_step: "network", step_data: {} });
  });

  it("saves progress via POST to /api/v1/setup", async () => {
    const { result } = renderHook(() => useSetupProgress());
    let promise;
    await act(async () => {
      promise = result.current.saveProgress("network", { network_connected: true });
      await promise;
    });
    expect(mockedPostJson).toHaveBeenCalledWith("/api/v1/setup", {
      current_step: "network",
      step_data: { network_connected: true },
    });
  });

  it("flushProgress waits for the in-flight save", async () => {
    /** @type {(() => void) | undefined} */
    let resolveSave;
    mockedPostJson.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = () => resolve({ ok: true });
      }),
    );
    const { result } = renderHook(() => useSetupProgress());
    await act(async () => {
      result.current.saveProgress("account", {});
    });
    let flushed = false;
    const flushPromise = act(async () => {
      await result.current.flushProgress();
      flushed = true;
    });
    expect(flushed).toBe(false);
    resolveSave?.();
    await flushPromise;
    expect(flushed).toBe(true);
  });
});
