import { describe, expect, it, vi } from "vitest";
import { calloutShakeTrigger, serializeShakeTrigger, shakeElement } from "./shake";

describe("shakeElement", () => {
  it("runs a horizontal animation on the element", () => {
    const el = document.createElement("div");
    const animate = vi.fn(() => /** @type {Animation} */ (/** @type {unknown} */ ({
      cancel: vi.fn(),
    })));
    el.animate = animate;
    el.getAnimations = vi.fn(() => []);

    shakeElement(el);

    expect(animate).toHaveBeenCalledTimes(1);
    /** @type {any} */
    const call = animate.mock.calls[0];
    expect(call[1]).toMatchObject({ duration: 500 });
  });
});

describe("serializeShakeTrigger", () => {
  it("returns empty string for cleared triggers", () => {
    expect(serializeShakeTrigger(null)).toBe("");
    expect(serializeShakeTrigger("")).toBe("");
  });

  it("serializes plain objects", () => {
    expect(serializeShakeTrigger({ form: "nope" })).toBe('{"form":"nope"}');
  });

  it("does not throw on circular structures", () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(serializeShakeTrigger(circular)).toBe("[object]");
  });
});

describe("calloutShakeTrigger", () => {
  it("uses string children for error callouts", () => {
    expect(calloutShakeTrigger("error", null, "Network error")).toBe("Network error");
  });

  it("ignores non-error tones", () => {
    expect(calloutShakeTrigger("info", "Oops", null)).toBe("");
  });
});
