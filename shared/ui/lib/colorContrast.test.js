import { describe, expect, it } from "vitest";
import { contrastRatio } from "./colorContrast";

describe("contrastRatio", () => {
  it("calculates the WCAG ratio for opaque computed RGB colors", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21);
  });

  it("composites translucent text over its rendered background", () => {
    expect(contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)")).toBeCloseTo(3.98, 2);
  });

  it("uses the ancestor surface as the backdrop for a translucent element surface", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)")).toBeCloseTo(5.28, 2);
  });
});
