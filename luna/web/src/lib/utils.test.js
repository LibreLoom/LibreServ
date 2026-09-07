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
