import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAnimatedHeight } from "./useAnimatedHeight.jsx";

describe("useAnimatedHeight", () => {
  it("returns outerRef and innerRef", () => {
    const { result } = renderHook(() => useAnimatedHeight());
    expect(result.current).toHaveProperty("outerRef");
    expect(result.current).toHaveProperty("innerRef");
    expect(result.current.outerRef.current).toBeNull();
    expect(result.current.innerRef.current).toBeNull();
  });
});
