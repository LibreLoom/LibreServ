import { describe, expect, it } from "vitest";
import { applyMarkdownAction } from "./markdown.js";

describe("applyMarkdownAction", () => {
  it("wraps the selection in bold markers and keeps it selected", () => {
    const r = applyMarkdownAction("say hi", 4, 6, "bold");
    expect(r.text).toBe("say **hi**");
    expect(r.text.slice(r.start, r.end)).toBe("hi");
  });

  it("inserts placeholder text when nothing is selected", () => {
    const r = applyMarkdownAction("", 0, 0, "italic");
    expect(r.text).toBe("*italic text*");
    expect(r.text.slice(r.start, r.end)).toBe("italic text");
  });

  it("toggles bold off when the selection is already wrapped", () => {
    const r = applyMarkdownAction("a **b** c", 4, 5, "bold");
    expect(r.text).toBe("a b c");
    expect(r.text.slice(r.start, r.end)).toBe("b");
  });

  it("inserts a link with the placeholder url selected", () => {
    const r = applyMarkdownAction("see docs", 4, 8, "link");
    expect(r.text).toBe("see [docs](https://)");
    expect(r.text.slice(r.start, r.end)).toBe("https://");
  });

  it("prefixes every selected line for a list", () => {
    const r = applyMarkdownAction("one\ntwo", 0, 7, "list");
    expect(r.text).toBe("- one\n- two");
    expect(r.start).toBe(0);
    expect(r.end).toBe(11);
  });

  it("toggles the heading prefix off when already present", () => {
    const r = applyMarkdownAction("## Title\nbody", 0, 8, "heading");
    expect(r.text).toBe("Title\nbody");
  });

  it("returns the input unchanged for unknown actions", () => {
    const r = applyMarkdownAction("abc", 0, 1, "nope");
    expect(r.text).toBe("abc");
    expect(r.start).toBe(0);
    expect(r.end).toBe(1);
  });
});
