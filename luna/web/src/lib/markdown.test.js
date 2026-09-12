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

  it("nests italic inside bold instead of stripping half the markers", () => {
    const r = applyMarkdownAction("**bold**", 2, 6, "italic");
    expect(r.text).toBe("***bold***");
    expect(r.text.slice(r.start, r.end)).toBe("bold");
  });

  it("removes italic from bold+italic without clearing bold", () => {
    const r = applyMarkdownAction("***bold***", 3, 7, "italic");
    expect(r.text).toBe("**bold**");
    expect(r.text.slice(r.start, r.end)).toBe("bold");
  });

  it("removes bold from bold+italic without clearing italic", () => {
    const r = applyMarkdownAction("***x***", 3, 4, "bold");
    expect(r.text).toBe("*x*");
    expect(r.text.slice(r.start, r.end)).toBe("x");
  });

  it("adds bold around italic by nesting star markers", () => {
    const r = applyMarkdownAction("*italic*", 1, 7, "bold");
    expect(r.text).toBe("***italic***");
    expect(r.text.slice(r.start, r.end)).toBe("italic");
  });

  it("toggles italic off when the selection is already wrapped", () => {
    const r = applyMarkdownAction("a *b* c", 3, 4, "italic");
    expect(r.text).toBe("a b c");
    expect(r.text.slice(r.start, r.end)).toBe("b");
  });
});
