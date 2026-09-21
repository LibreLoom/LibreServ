import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("haptics", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("fires every supported vibration preset", async () => {
    const { haptic } = await import("./haptics.js");
    const presets = [
      "selection",
      "light",
      "medium",
      "heavy",
      "rigid",
      "soft",
      "success",
      "warning",
      "error",
      "nudge",
    ];

    for (const preset of presets) haptic(preset);
    haptic();
    haptic("not-a-preset");

    expect(navigator.vibrate).toHaveBeenCalledTimes(presets.length + 1);
    expect(navigator.vibrate).toHaveBeenCalledWith([35]);
    expect(navigator.vibrate).toHaveBeenCalledWith([10, 10, 5, 65, 40]);
  });

  it("does not vibrate when the preference is disabled", async () => {
    const { haptic, setHapticsEnabled } = await import("./haptics.js");

    setHapticsEnabled(false);
    haptic("error");
    expect(navigator.vibrate).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    haptic("rigid");
    expect(navigator.vibrate).toHaveBeenCalledWith([10]);
  });

  it("publishes reactive preference changes", async () => {
    const { setHapticsEnabled, useHapticsEnabled } =
      await import("./haptics.js");
    const { result, unmount } = renderHook(() => useHapticsEnabled());

    expect(result.current).toBe(true);
    act(() => setHapticsEnabled(false));
    expect(result.current).toBe(false);

    localStorage.setItem("haptics-enabled", "true");
    act(() => window.dispatchEvent(new StorageEvent("storage")));
    expect(result.current).toBe(true);
    unmount();
  });

  it("continues when browser storage is unavailable", async () => {
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    const { haptic, setHapticsEnabled } = await import("./haptics.js");

    expect(() => setHapticsEnabled(false)).not.toThrow();
    haptic("light");
    expect(navigator.vibrate).toHaveBeenCalled();

    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  it("silently skips vibration on unsupported platforms", async () => {
    delete navigator.vibrate;
    vi.resetModules();
    const { haptic } = await import("./haptics.js");

    expect(() => haptic("light")).not.toThrow();
  });
});
