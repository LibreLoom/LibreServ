import { describe, expect, it } from "vitest";
import { CREATE_KINDS, createKindsFor, groupedCreateKinds } from "./createKinds.js";

describe("createKinds", () => {
  it("lists folder and text file today", () => {
    expect(CREATE_KINDS.map((kind) => kind.id)).toEqual(["folder", "text"]);
  });

  it("filters the catalog for pickers that only need a folder", () => {
    expect(createKindsFor(["folder"]).map((kind) => kind.id)).toEqual(["folder"]);
    expect(createKindsFor(null)).toEqual(CREATE_KINDS);
  });

  it("groups kinds so later office types can sit under headings", () => {
    const groups = groupedCreateKinds();
    expect(groups.map((group) => group.label)).toEqual(["Organize", "Files"]);
    expect(groups[0].items.map((kind) => kind.id)).toEqual(["folder"]);
    expect(groups[1].items.map((kind) => kind.id)).toEqual(["text"]);
  });
});
