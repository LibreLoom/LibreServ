import { describe, expect, it } from "vitest";
import { cn } from "./utils.js";

describe("cn / twMerge custom radii", () => {
  it("lets rounded-large-element replace rounded-pill", () => {
    expect(cn("rounded-pill", "rounded-large-element")).toBe("rounded-large-element");
  });

  it("lets rounded-pill replace rounded-large-element", () => {
    expect(cn("rounded-large-element", "rounded-pill")).toBe("rounded-pill");
  });

  it("keeps a single radius when Button-like classes stack to a card", () => {
    const stacked = cn(
      "inline-flex rounded-pill font-medium",
      "h-auto items-stretch justify-start rounded-large-element py-3 text-left",
    );
    expect(stacked).toMatch(/\brounded-large-element\b/);
    expect(stacked).not.toMatch(/\brounded-pill\b/);
  });
});

describe("cn / twMerge surfaces", () => {
  it("lets a later surface replace an earlier one", () => {
    expect(cn("surface-secondary p-4", "surface-primary")).toBe("p-4 surface-primary");
  });

  it("lets a surface replace earlier bg and text colors", () => {
    expect(cn("bg-secondary text-primary", "surface-primary")).toBe("surface-primary");
  });

  it("keeps the surface when a later utility overrides one property", () => {
    expect(cn("surface-primary", "bg-error/20")).toBe("surface-primary bg-error/20");
    expect(cn("surface-primary", "text-error")).toBe("surface-primary text-error");
  });
});
