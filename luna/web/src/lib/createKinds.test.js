import { describe, expect, it } from "vitest";
import { CREATE_KINDS, createKindsFor, groupedCreateKinds } from "./createKinds.js";

describe("createKinds", () => {
  it("lists folder, text, office types, and forms", () => {
    expect(CREATE_KINDS.map((kind) => kind.id)).toEqual([
      "folder",
      "text",
      "document",
      "spreadsheet",
      "presentation",
      "diagram",
      "form",
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
      "diagram",
      "form",
    ]);
  });

  it("marks office kinds to open in the viewer with OOXML stubs", () => {
    const doc = CREATE_KINDS.find((k) => k.id === "document");
    expect(doc?.openAfter).toBe("viewer");
    expect(doc?.stub).toBe("docx");
  });

  it("creates diagrams with a valid blank .drawio file, opened in the viewer", () => {
    const diagram = CREATE_KINDS.find((k) => k.id === "diagram");
    expect(diagram?.group).toBe("Office");
    expect(diagram?.openAfter).toBe("viewer");
    expect(diagram?.defaultExt).toBe(".drawio");
    const xml = diagram?.initialContent?.() || "";
    expect(xml).toContain("<mxfile");
    expect(xml).toContain("<diagram");
  });

  it("creates forms with a valid .lunaform envelope, opened in the viewer", () => {
    const form = CREATE_KINDS.find((k) => k.id === "form");
    expect(form?.openAfter).toBe("viewer");
    expect(form?.defaultExt).toBe(".lunaform");
    const doc = JSON.parse(form?.initialContent?.() || "{}");
    expect(doc.version).toBe(1);
    expect(doc.questions).toEqual([]);
    expect(doc.settings.collecting).toBe(true);
  });
});
