import { describe, expect, it } from "vitest";
import { CREATE_KINDS, createKindsFor, groupedCreateKinds } from "./createKinds.js";

describe("createKinds", () => {
  it("lists folder, text, and office types", () => {
    expect(CREATE_KINDS.map((kind) => kind.id)).toEqual([
      "folder",
      "text",
      "document",
      "spreadsheet",
      "presentation",
    ]);
  });

  it("filters the catalog for pickers that only need a folder", () => {
    expect(createKindsFor(["folder"]).map((kind) => kind.id)).toEqual(["folder"]);
    expect(createKindsFor(null)).toEqual(CREATE_KINDS);
  });

  it("groups kinds under Organize, Files, and Office", () => {
    const groups = groupedCreateKinds();
    expect(groups.map((group) => group.label)).toEqual(["Organize", "Files", "Office"]);
    expect(groups[0].items.map((kind) => kind.id)).toEqual(["folder"]);
    expect(groups[1].items.map((kind) => kind.id)).toEqual(["text"]);
    expect(groups[2].items.map((kind) => kind.id)).toEqual([
      "document",
      "spreadsheet",
      "presentation",
    ]);
  });

  it("marks office kinds to open in the viewer with OOXML stubs", () => {
    const doc = CREATE_KINDS.find((k) => k.id === "document");
    expect(doc?.openAfter).toBe("viewer");
    expect(doc?.stub).toBe("docx");
  });
});
