import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import useLabelErrorState from "../hooks/useLabelErrorState";

describe("useLabelErrorState", () => {
  it("starts normal and turns error when a failure signal appears", () => {
    const { result, rerender } = renderHook(
      ({ error }) => useLabelErrorState(error, null),
      { initialProps: { error: null } },
    );

    expect(result.current.labelError).toBe(false);

    rerender({ error: "Required" });
    expect(result.current.labelError).toBe(true);
  });

  it("clears on form submit and returns to error after loading when still invalid", () => {
    const form = document.createElement("form");
    const label = document.createElement("label");
    form.appendChild(label);
    document.body.appendChild(form);

    const { result, rerender } = renderHook(
      ({ error, loading }) => useLabelErrorState(error, null, { loading }),
      { initialProps: { error: "Bad password", loading: false } },
    );

    act(() => {
      result.current.containerRef(label);
    });
    rerender({ error: "Bad password", loading: false });
    expect(result.current.labelError).toBe(true);

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    rerender({ error: "Bad password", loading: false });
    expect(result.current.labelError).toBe(false);

    rerender({ error: "Bad password", loading: true });
    expect(result.current.labelError).toBe(false);

    rerender({ error: "Bad password", loading: false });
    expect(result.current.labelError).toBe(true);

    form.remove();
  });

  it("stays normal when the failure signal clears", () => {
    const { result, rerender } = renderHook(
      ({ error }) => useLabelErrorState(error, null),
      { initialProps: { error: "Nope" } },
    );

    expect(result.current.labelError).toBe(true);

    rerender({ error: null });
    expect(result.current.labelError).toBe(false);
  });
});
