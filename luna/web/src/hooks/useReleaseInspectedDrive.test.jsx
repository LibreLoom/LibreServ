import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import useReleaseInspectedDrive from "./useReleaseInspectedDrive.js";

const api = vi.hoisted(() => ({ postJson: vi.fn() }));
const toasts = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../lib/api.js", async (original) => ({ ...(await original()), postJson: api.postJson }));
vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({ useToast: () => toasts }));

describe("useReleaseInspectedDrive", () => {
  it("lets go quietly when it works", async () => {
    api.postJson.mockReset().mockResolvedValue({ ok: true });
    toasts.addToast.mockReset();
    const { result } = renderHook(() => useReleaseInspectedDrive());
    await result.current({ name: "sdb1", model: "SanDisk" });
    expect(api.postJson).toHaveBeenCalledWith("/api/v1/drives/sdb1/release", {});
    expect(toasts.addToast).not.toHaveBeenCalled();
  });

  it("tells the person once, by drive name, when it fails", async () => {
    api.postJson.mockReset().mockRejectedValue(new Error("boom"));
    toasts.addToast.mockReset();
    const { result } = renderHook(() => useReleaseInspectedDrive());
    await result.current({ name: "sdb1", model: "SanDisk" });
    expect(toasts.addToast).toHaveBeenCalledOnce();
    expect(toasts.addToast).toHaveBeenCalledWith({
      type: "error",
      message: "Luna couldn't finish closing SanDisk.",
      description: "Unplug it, wait a few seconds, and plug it back in.",
    });
  });

  it("skips the demo drive without a request or a toast", async () => {
    const { MOCK_UNKNOWN_PSSD_NAME } = await import("../lib/devMockDrives.js");
    api.postJson.mockReset();
    toasts.addToast.mockReset();
    const { result } = renderHook(() => useReleaseInspectedDrive());
    await result.current({ name: MOCK_UNKNOWN_PSSD_NAME });
    expect(api.postJson).not.toHaveBeenCalled();
    expect(toasts.addToast).not.toHaveBeenCalled();
  });
});
