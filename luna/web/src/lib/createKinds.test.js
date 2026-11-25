import { describe, expect, it } from "vitest";
import { CREATE_KINDS, createKindsFor, groupedCreateKinds } from "./createKinds.js";

describe("createKinds", () => {
  it("lists folder, text, office types, and forms", () => {
    expect(CREATE_KINDS.map((kind) => kind.id)).toEqual([
      "folder",
      "private-folder",
      "text",
      "database",
      "document",
      "spreadsheet",
      "presentation",
      "diagram",
      "whiteboard",
      "form",
    ]);
  });

  it("keeps Private kinds out unless they are asked for", () => {
    expect(createKindsFor(null).some((kind) => kind.private)).toBe(false);
    expect(createKindsFor(null, true).map((kind) => kind.id)).toContain("private-folder");
    // Folder-only pickers never get Private, even when the feature is on.
    expect(createKindsFor(["folder"], true).map((kind) => kind.id)).toEqual(["folder"]);
  });

  it("filters the catalog for pickers that only need a folder", () => {
    expect(createKindsFor(["folder"]).map((kind) => kind.id)).toEqual(["folder"]);
    expect(createKindsFor(null)).toEqual(CREATE_KINDS.filter((kind) => !kind.private));
  });

  it("groups kinds under Organize, Files, and Office, with private folders in Organize", () => {
    const groups = groupedCreateKinds();
    expect(groups.map((group) => group.label)).toEqual(["Organize", "Files", "Office"]);
    expect(groups[0].items.map((kind) => kind.id)).toEqual(["folder", "private-folder"]);
    expect(groups[1].items.map((kind) => kind.id)).toEqual(["text", "database"]);
    expect(groups[2].items.map((kind) => kind.id)).toEqual([
      "document",
      "spreadsheet",
      "presentation",
      "diagram",
      "whiteboard",
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

  it("creates whiteboards with a valid blank .excalidraw scene", () => {
    const whiteboard = CREATE_KINDS.find((k) => k.id === "whiteboard");
    expect(whiteboard?.group).toBe("Office");
    expect(whiteboard?.label).toBe("Whiteboard");
    expect(whiteboard?.openAfter).toBe("viewer");
    expect(whiteboard?.defaultName).toBe("Whiteboard.excalidraw");
    expect(whiteboard?.defaultExt).toBe(".excalidraw");
    const scene = JSON.parse(whiteboard?.initialContent?.() || "{}");
    expect(scene.type).toBe("excalidraw");
    expect(scene.elements).toEqual([]);
    expect(scene.appState).toBeTypeOf("object");
    expect(scene.files).toEqual({});
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

  it("creates a real blank SQLite database with a .sqlite3 name", () => {
    const database = CREATE_KINDS.find((k) => k.id === "database");
    expect(database?.group).toBe("Files");
    expect(database?.openAfter).toBe("viewer");
    expect(database?.defaultName).toBe("Database.sqlite3");
    expect(database?.defaultExt).toBe(".sqlite3");
    const bytes = database?.initialBytes?.() || new Uint8Array();
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe("SQLite format 3\0");
    expect(bytes.byteLength).toBe(4096);
  });

  it("defaults text files to markdown (.md)", () => {
    const text = CREATE_KINDS.find((k) => k.id === "text");
    expect(text?.openAfter).toBe("text");
    expect(text?.defaultName).toBe("note.md");
    expect(text?.defaultExt).toBe(".md");
    expect(text?.placeholder).toBe("e.g. Shopping list.md");
  });
});
