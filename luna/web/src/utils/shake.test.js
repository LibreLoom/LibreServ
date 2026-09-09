import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shakeElement, serializeShakeTrigger, calloutShakeTrigger } from "./shake.js";
import * as haptics from "./haptics.js";

describe("shakeElement & haptics", () => {
  let hapticSpy;

  beforeEach(() => {
    hapticSpy = vi.spyOn(haptics, "haptic").mockImplementation(() => {});
  });

  afterEach(() => {
    hapticSpy.mockRestore();
  });

  it("fires error haptic and runs element animation on valid element", () => {
    const cancelMock = vi.fn();
    const animateMock = vi.fn().mockReturnValue({});
    const el = {
      animate: animateMock,
      getAnimations: vi.fn().mockReturnValue([{ cancel: cancelMock }]),
    };

    shakeElement(/** @type {any} */ (el));

    expect(hapticSpy).toHaveBeenCalledWith("error");
    expect(cancelMock).toHaveBeenCalled();
    expect(animateMock).toHaveBeenCalled();
  });

  it("returns undefined and does not fire haptic if element is null or cannot animate", () => {
    expect(shakeElement(null)).toBeUndefined();
    expect(shakeElement(/** @type {any} */ ({}))).toBeUndefined();
    expect(hapticSpy).not.toHaveBeenCalled();
  });

  it("serializes triggers correctly", () => {
    expect(serializeShakeTrigger(null)).toBe("");
    expect(serializeShakeTrigger(false)).toBe("");
    expect(serializeShakeTrigger("auth-error")).toBe("auth-error");
    expect(serializeShakeTrigger(42)).toBe("42");
    expect(serializeShakeTrigger({ code: 1 })).toBe('{"code":1}');
  });

  it("extracts callout triggers only for error tone", () => {
    expect(calloutShakeTrigger("info", "Title")).toBe("");
    expect(calloutShakeTrigger("error", "Failed to connect")).toBe("Failed to connect");
  });
});
