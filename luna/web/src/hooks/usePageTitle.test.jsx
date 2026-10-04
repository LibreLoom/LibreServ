import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import usePageTitle from "./usePageTitle.js";

describe("usePageTitle", () => {
  it("puts the title before the app name", () => {
    renderHook(() => usePageTitle("Files"));
    expect(document.title).toBe("Files · Luna");
  });

  it("falls back to the app name without a title", () => {
    renderHook(() => usePageTitle(""));
    expect(document.title).toBe("Luna");
  });

  it("follows the title as it changes", () => {
    const { rerender } = renderHook(({ t }) => usePageTitle(t), { initialProps: { t: "Photos" } });
    rerender({ t: "Holiday" });
    expect(document.title).toBe("Holiday · Luna");
  });
});
