import { describe, expect, it } from "vitest";
import { parseCreateName } from "./createName.js";

describe("parseCreateName", () => {
  it("trims and accepts a simple name", () => {
    expect(parseCreateName("  Album  ")).toEqual({ name: "Album" });
  });

  it("rejects empty, slashes, and dot names", () => {
    expect(parseCreateName("")).toEqual({ error: "Choose a name." });
    expect(parseCreateName("  ")).toEqual({ error: "Choose a name." });
    expect(parseCreateName("a/b")).toMatchObject({ error: expect.stringMatching(/\/ or \\/) });
    expect(parseCreateName("a\\b")).toMatchObject({ error: expect.stringMatching(/\/ or \\/) });
    expect(parseCreateName(".")).toEqual({ error: "Choose a different name." });
    expect(parseCreateName("..")).toEqual({ error: "Choose a different name." });
  });

  it("appends a default extension when the name has no dot", () => {
    expect(parseCreateName("shopping", { defaultExt: ".txt" })).toEqual({ name: "shopping.txt" });
    expect(parseCreateName("notes.md", { defaultExt: ".txt" })).toEqual({ name: "notes.md" });
    expect(parseCreateName("note.txt", { defaultExt: ".txt" })).toEqual({ name: "note.txt" });
  });
});
