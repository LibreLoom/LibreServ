import { describe, expect, it } from "vitest";
import { showPageLevelError } from "./modalScopedError.js";

describe("showPageLevelError", () => {
  it("shows page errors when no modal is open", () => {
    expect(showPageLevelError("Something failed.", false)).toBe(true);
  });

  it("hides page errors while a modal is open", () => {
    expect(showPageLevelError("Something failed.", true)).toBe(false);
  });

  it("hides when error is empty", () => {
    expect(showPageLevelError(null, false)).toBe(false);
    expect(showPageLevelError("", false)).toBe(false);
  });
});
