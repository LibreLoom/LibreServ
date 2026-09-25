import { describe, expect, it } from "vitest";
import { KIND_ALBUM } from "./access.js";
import {
  CAP,
  capsOnPath,
  hasCapOnDrive,
  memberAccessRoots,
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
});
