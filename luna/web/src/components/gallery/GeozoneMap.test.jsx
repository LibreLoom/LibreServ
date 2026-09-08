import { describe, expect, it } from "vitest";
import { bboxToBounds, boundsToBbox } from "./GeozoneMap.jsx";

describe("GeozoneMap helpers", () => {
  it("round-trips bbox and leaflet bounds", () => {
    const bbox = /** @type {[number, number, number, number]} */ ([-10, 20, -5, 30]);
    const bounds = bboxToBounds(bbox);
    expect(bounds).toEqual([
      [20, -10],
      [30, -5],
    ]);
    expect(boundsToBbox(bounds)).toEqual(bbox);
  });

  it("returns null for invalid bbox", () => {
    expect(bboxToBounds(null)).toBeNull();
    expect(bboxToBounds([1, 2, 3])).toBeNull();
  });
});
