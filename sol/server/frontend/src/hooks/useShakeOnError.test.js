import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import useShakeOnError from "../hooks/useShakeOnError";

function mockElement() {
  const el = document.createElement("input");
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  el.animate = animate;
  el.getAnimations = vi.fn(() => []);
  return { el, animate };
}

describe("useShakeOnError", () => {
  it("shakes when the trigger first appears", () => {
    const { el, animate } = mockElement();
    const ref = { current: el };

    const { rerender } = renderHook(({ trigger }) => useShakeOnError(trigger, ref), {
      initialProps: { trigger: null },
    });

    expect(animate).not.toHaveBeenCalled();

    rerender({ trigger: "Invalid password" });
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("shakes again on form resubmit while the trigger is unchanged", () => {
    const form = document.createElement("form");
    const { el, animate } = mockElement();
    form.appendChild(el);
    document.body.appendChild(form);
    const ref = { current: el };

    const { rerender } = renderHook(
      ({ trigger, loading }) => useShakeOnError(trigger, ref, { loading }),
      { initialProps: { trigger: "401", loading: false } },
    );

    expect(animate).toHaveBeenCalledTimes(1);

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    rerender({ trigger: "401", loading: true });
    expect(animate).toHaveBeenCalledTimes(1);

    rerender({ trigger: "401", loading: false });
    expect(animate).toHaveBeenCalledTimes(2);

    form.remove();
  });

  it("shakes immediately on resubmit when loading is not wired", () => {
    const form = document.createElement("form");
    const { el, animate } = mockElement();
    form.appendChild(el);
    document.body.appendChild(form);
    const ref = { current: el };

    const { rerender } = renderHook(({ trigger }) => useShakeOnError(trigger, ref), {
      initialProps: { trigger: "Required" },
    });

    expect(animate).toHaveBeenCalledTimes(1);

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    rerender({ trigger: "Required" });

    expect(animate).toHaveBeenCalledTimes(2);

    form.remove();
  });
});
