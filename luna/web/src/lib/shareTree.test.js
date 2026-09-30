import { describe, expect, it } from "vitest";
import { KIND_ALBUM } from "./access.js";
import {
  CAP,
  capsOnPath,
  hasCapOnDrive,
  memberAccessRoots,
  memberFileHref,
  memberPathFloor,
  memberSearchHref,
  memberWritableRoots,
  pathContains,
  pathKey,
} from "./shareTree.js";

describe("shareTree", () => {
  it("normalizes trailing slashes before compare", () => {
    expect(pathKey("/album/dcim/")).toBe("album/dcim");
    expect(pathContains("/album/", "album/dcim")).toBe(true);
    expect(pathContains("album/dcim", "album")).toBe(false);
  });

  it("hides a nested row when a parent already covers its caps", () => {
    const roots = memberAccessRoots([
      { id: "p", kind: "path", drive_id: "d1", path: "album", caps: "view" },
      { id: "c", kind: "path", drive_id: "d1", path: "album/print", caps: "view" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["p"]);
  });

  it("keeps a stronger folder under a weaker parent", () => {
    const roots = memberAccessRoots([
      { id: "drive", kind: "path", drive_id: "d1", path: "", caps: "view" },
      { id: "dcim", kind: "path", drive_id: "d1", path: "DCIM", caps: "full" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["drive", "dcim"]);
  });

  it("drops a child whose caps the widened parent now covers", () => {
    const roots = memberAccessRoots([
      { id: "p", kind: "path", drive_id: "d1", path: "album", caps: "full" },
      { id: "c", kind: "path", drive_id: "d1", path: "album/print", caps: "view+upload" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["p"]);
  });

  it("unions caps across containing rows and ignores other drives", () => {
    const rows = [
      { id: "a", kind: "path", drive_id: "d1", path: "photos", caps: "view" },
      { id: "b", kind: "path", drive_id: "d1", path: "", caps: "upload" },
      { id: "c", kind: "path", drive_id: "d2", path: "", caps: "full" },
    ];
    expect(capsOnPath(rows, "d1", "photos/dcim/x.jpg") & (CAP.VIEW | CAP.UPLOAD)).toBe(
      CAP.VIEW | CAP.UPLOAD,
    );
    expect(capsOnPath(rows, "d1", "other")).toBe(CAP.UPLOAD);
    expect(capsOnPath(rows, "d2", "anything")).toBe(CAP.VIEW | CAP.UPLOAD | CAP.EDIT);
  });

  it("detects a capability anywhere on a drive", () => {
    const rows = [
      { id: "r", kind: "path", drive_id: "d1", path: "album", caps: "view" },
      { id: "w", kind: "path", drive_id: "d2", path: "notes", caps: "full" },
    ];
    expect(hasCapOnDrive(rows, "d1", CAP.EDIT)).toBe(false);
    expect(hasCapOnDrive(rows, "d2", CAP.EDIT)).toBe(true);
  });

  it("album rows are roots of their own, never hidden by path rows", () => {
    const roots = memberAccessRoots([
      { id: "p", kind: "path", drive_id: "d1", path: "", caps: "full" },
      { id: "a", kind: KIND_ALBUM, drive_id: "d1", album_id: "alb-1", caps: "view" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["p", "a"]);
  });

  it("floors browsing at the shallowest grant containing the path", () => {
    const rows = [
      { id: "docs", kind: "path", drive_id: "d1", path: "docs", caps: "view" },
      { id: "deep", kind: "path", drive_id: "d1", path: "docs/reports", caps: "full" },
      { id: "other-drive", kind: "path", drive_id: "d2", path: "", caps: "view" },
      { id: "album", kind: KIND_ALBUM, drive_id: "d1", album_id: "al1", caps: "view" },
    ];
    // A deeper sibling grant never raises the floor — `docs` is browsable.
    expect(memberPathFloor(rows, "d1", "docs/reports/2024")).toBe("docs");
    expect(memberPathFloor(rows, "d1", "docs")).toBe("docs");
  });

  it("offers only present, writable folders as destinations", () => {
    const rows = [
      { id: "a", kind: "path", drive_id: "d1", path: "docs", name: "Docs", caps: "full" },
      { id: "b", kind: "path", drive_id: "d1", path: "readonly", caps: "view" },
      { id: "c", kind: "path", drive_id: "gone", path: "", caps: "full" },
      { id: "d", kind: "path", drive_id: "d1", path: "one.txt", is_file: true, caps: "full" },
      { id: "e", kind: KIND_ALBUM, drive_id: "d1", album_id: "al1", caps: "full" },
      { id: "f", kind: "path", drive_id: "d1", path: "drop", caps: "upload" },
    ];
    const roots = memberWritableRoots(rows, (id) => id === "d1", () => "Photos");
    expect(roots).toEqual([
      { driveId: "d1", path: "docs", label: "Docs" },
      { driveId: "d1", path: "drop", label: "drop" },
    ]);
  });

  it("treats a whole-drive grant as the normal root", () => {
    const rows = [{ id: "w", kind: "path", drive_id: "d1", path: "", caps: "view" }];
    expect(memberPathFloor(rows, "d1", "anywhere/deep")).toBe("");
  });

  it("pins the floor at the current path when grants exist but none cover it", () => {
    const rows = [{ id: "g", kind: "path", drive_id: "d1", path: "docs", caps: "view" }];
    // Nothing above `photos` is reachable — the floor is the path itself.
    expect(memberPathFloor(rows, "d1", "photos")).toBe("photos");
    // Drive root stays the root (the 403 notice handles the empty list).
    expect(memberPathFloor(rows, "d1", "")).toBe("");
    // No rows at all → no floor.
    expect(memberPathFloor([], "d1", "photos")).toBe("");
    expect(memberPathFloor(undefined, "d1", "photos")).toBe("");
  });

  it("links a member file through its parent only when the parent is browsable", () => {
    const folderGrant = [
      { id: "g", kind: "path", drive_id: "d1", path: "docs", caps: "view" },
    ];
    expect(memberFileHref(folderGrant, "d1", "docs/report.pdf"))
      .toBe("/drives/d1?path=docs&file=report.pdf");

    // File grant — `docs` 403s, so the file itself is the browsed path and
    // `?file=` carries the full path for the viewer.
    const fileGrant = [
      { id: "g", kind: "path", drive_id: "d1", path: "docs/report.pdf", caps: "view" },
    ];
    expect(memberFileHref(fileGrant, "d1", "docs/report.pdf"))
      .toBe("/drives/d1?path=docs%2Freport.pdf&file=docs%2Freport.pdf");
  });

  it("routes member search hits at ungranted parents through the file root", () => {
    const fileGrant = [
      { id: "g", kind: "path", drive_id: "d1", path: "docs/report.pdf", caps: "view" },
    ];
    expect(memberSearchHref(fileGrant, {
      drive_id: "d1", path: "docs/report.pdf", kind: "file", parent: "docs",
    })).toBe("/drives/d1?path=docs%2Freport.pdf&file=docs%2Freport.pdf");
    // Folders the search returned are viewable — keep the folder link.
    expect(memberSearchHref(fileGrant, {
      drive_id: "d1", path: "docs", kind: "dir",
    })).toBe("/drives/d1?path=docs");
    // Covered parents keep the select= deep link.
    const folderGrant = [
      { id: "g", kind: "path", drive_id: "d1", path: "docs", caps: "view" },
    ];
    expect(memberSearchHref(folderGrant, {
      drive_id: "d1", path: "docs/x.txt", kind: "file", parent: "docs",
    })).toBe("/drives/d1?path=docs&select=docs%2Fx.txt");
  });
});
