import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useMultiSelect, { photoSelectionKey } from "./useMultiSelect.js";

const photos = [
  { drive_id: "a", path: "1.jpg" },
  { drive_id: "a", path: "2.jpg" },
  { drive_id: "a", path: "3.jpg" },
];

describe("useMultiSelect", () => {
  it("enters select mode on toggle and tracks selection", () => {
    const { result } = renderHook(() => useMultiSelect({ items: photos }));
    expect(result.current.selectMode).toBe(false);

    act(() => result.current.toggle(photos[0]));
    expect(result.current.selectMode).toBe(true);
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.isSelected(photos[0])).toBe(true);
  });

  it("supports shift-range selection across items in view", () => {
    const { result } = renderHook(() => useMultiSelect({ items: photos }));
    act(() => result.current.toggle(photos[0]));
    act(() => result.current.toggle(photos[2], { range: true }));
    expect(result.current.selectedCount).toBe(3);
    expect([...result.current.selected]).toEqual([
      photoSelectionKey(photos[0]),
      photoSelectionKey(photos[1]),
      photoSelectionKey(photos[2]),
    ]);
  });

  it("clears on exit and selectAllInView fills the set", () => {
    const { result } = renderHook(() => useMultiSelect({ items: photos }));
    act(() => result.current.selectAllInView());
    expect(result.current.selectedCount).toBe(3);
    act(() => result.current.exit());
    expect(result.current.selectMode).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });
});
