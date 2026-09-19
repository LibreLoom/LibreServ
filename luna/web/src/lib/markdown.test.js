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

  it("wraps the selection in strikethrough markers", () => {
    const r = applyMarkdownAction("old price", 0, 9, "strikethrough");
    expect(r.text).toBe("~~old price~~");
  });

  it("prefixes selected lines as a checklist", () => {
    const r = applyMarkdownAction("milk\neggs", 0, 9, "task");
    expect(r.text).toBe("- [ ] milk\n- [ ] eggs");
  });

  it("prefixes selected lines as a quote", () => {
    const r = applyMarkdownAction("hello", 0, 5, "quote");
    expect(r.text).toBe("> hello");
  });

  it("fences the selection as a code block", () => {
    const r = applyMarkdownAction("let x = 1", 0, 9, "codeblock");
    expect(r.text).toBe("```\nlet x = 1\n```\n");
    expect(r.text.slice(r.start, r.end)).toBe("let x = 1");
  });

  it("adds a leading break before a code block mid-line", () => {
    const r = applyMarkdownAction("before code", 7, 11, "codeblock");
    expect(r.text).toBe("before \n```\ncode\n```\n");
  });

  it("inserts a table skeleton and parks the cursor after it", () => {
    const r = applyMarkdownAction("", 0, 0, "table");
    expect(r.text).toContain("| Column | Column |");
    // Cursor sits past the block so the live preview renders the grid.
    expect(r.start).toBe(r.text.length);
    expect(r.start).toBe(r.end);
  });

  it("inserts a horizontal rule", () => {
    const r = applyMarkdownAction("para", 4, 4, "hr");
    expect(r.text).toBe("para\n\n---\n");
    expect(r.start).toBe(r.end);
  });

  it.each([1, 2, 3, 4, 5, 6])("sets heading level %i", (level) => {
    const result = applyMarkdownAction("Title", 0, 5, `heading${level}`);
    expect(result.text).toBe(`${"#".repeat(level)} Title`);
    expect(result.text.slice(result.start, result.end)).toBe("Title");
  });

  it.each([1, 2, 3, 4, 5, 6])("starts an empty heading %i", (level) => {
    const result = applyMarkdownAction("", 0, 0, `heading${level}`);
    expect(result).toEqual({
      text: `${"#".repeat(level)} `,
      start: level + 1,
      end: level + 1,
    });
  });

  it("changes heading levels without stacking and is idempotent", () => {
    const first = applyMarkdownAction("## Title", 5, 5, "heading6");
    expect(first).toEqual({ text: "###### Title", start: 9, end: 9 });
    expect(
      applyMarkdownAction(first.text, first.start, first.end, "heading6"),
    ).toEqual(first);
  });

  it("converts selected lines but keeps blank separators and the following line", () => {
    const text = "# One\n\n### Two\nuntouched";
    const end = text.indexOf("untouched");
    expect(applyMarkdownAction(text, 0, end, "heading4").text).toBe(
      "#### One\n\n#### Two\nuntouched",
    );
  });

  it("starts a heading on a blank first line", () => {
    expect(applyMarkdownAction("\nbody", 0, 0, "heading1")).toEqual({
      text: "# \nbody",
      start: 2,
      end: 2,
    });
  });

  it("preserves permitted heading indentation and literal hashes", () => {
    expect(applyMarkdownAction("  ### Title", 6, 11, "heading1").text).toBe(
      "  # Title",
    );
    expect(applyMarkdownAction("#tag", 0, 4, "heading2").text).toBe("## #tag");
    expect(applyMarkdownAction("####### nope", 0, 12, "heading1").text).toBe(
      "# ####### nope",
    );
  });

  it.each([0, 7])("leaves unknown heading%i unchanged", (level) => {
    const r = applyMarkdownAction("Title", 0, 5, `heading${level}`);
    expect(r).toEqual({ text: "Title", start: 0, end: 5 });
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
