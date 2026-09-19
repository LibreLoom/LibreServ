import { describe, expect, it } from "vitest";
import { fileHref, folderHref, parentPath, searchResultHref } from "./paths.js";

describe("searchResultHref", () => {
  it("opens a folder hit into that folder", () => {
    expect(
      searchResultHref({
        drive_id: "d1",
        path: "Documents/taxes-2024",
        parent: "Documents",
        kind: "dir",
      }),
    ).toBe("/drives/d1?path=Documents%2Ftaxes-2024");
  });

  it("opens a root folder hit with a path query", () => {
    expect(
      searchResultHref({
        drive_id: "d1",
        path: "album",
        parent: "",
        kind: "dir",
      }),
    ).toBe("/drives/d1?path=album");
  });

  it("opens a file hit in its parent and selects the file", () => {
    expect(
      searchResultHref({
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        kind: "file",
      }),
    ).toBe("/drives/d1?path=album&select=album%2Fbeach.jpg");
  });

  it("selects a root-level file without a path query", () => {
    expect(
      searchResultHref({
        drive_id: "d1",
        path: "notes.txt",
        parent: "",
        kind: "file",
      }),
    ).toBe("/drives/d1?select=notes.txt");
  });

  it("derives parent from path when parent is omitted", () => {
    expect(
      searchResultHref({
        drive_id: "d1",
        path: "Documents/taxes.pdf",
        kind: "file",
      }),
    ).toBe("/drives/d1?path=Documents&select=Documents%2Ftaxes.pdf");
  });
});

describe("folderHref / parentPath", () => {
  it("builds drive and folder hrefs", () => {
    expect(folderHref("d1", "")).toBe("/drives/d1");
    expect(folderHref("d1", "album")).toBe("/drives/d1?path=album");
  });

  it("returns parent folders", () => {
    expect(parentPath("")).toBe(null);
    expect(parentPath("album")).toBe("");
    expect(parentPath("album/beach.jpg")).toBe("album");
  });
});

describe("fileHref", () => {
  it("builds file href at drive root", () => {
    expect(fileHref("d1", "notes.txt")).toBe("/drives/d1?file=notes.txt");
  });

  it("builds file href inside a subfolder", () => {
    expect(fileHref("d1", "Documents/taxes.pdf")).toBe("/drives/d1?path=Documents&file=taxes.pdf");
  });

  it("builds file href inside nested subfolders", () => {
    expect(fileHref("d1", "Documents/2024/work/taxes.pdf")).toBe("/drives/d1?path=Documents%2F2024%2Fwork&file=taxes.pdf");
  });
});
