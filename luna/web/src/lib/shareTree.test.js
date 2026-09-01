import { describe, expect, it } from "vitest";
import {
  canWriteOnPath,
  dedupeIdenticalGrants,
  hasWriteOnDrive,
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

  it("hides a nested read when a parent already covers it", () => {
    const roots = memberAccessRoots([
      { id: "p", user_id: "2", drive_id: "d1", path: "album", permission: "read" },
      { id: "c", user_id: "2", drive_id: "d1", path: "album/print", permission: "read" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["p"]);
  });

  it("keeps a write folder under a read parent", () => {
    const roots = memberAccessRoots([
      { id: "drive", user_id: "2", drive_id: "d1", path: "", permission: "read" },
      { id: "dcim", user_id: "2", drive_id: "d1", path: "DCIM", permission: "write" },
    ]);
    expect(roots.map((g) => g.id)).toEqual(["drive", "dcim"]);
  });

  it("dedupes identical rows and allows write on the current object or a parent", () => {
    const grants = dedupeIdenticalGrants([
      { id: "a", user_id: "2", drive_id: "d1", path: "/photos/", permission: "write" },
      { id: "b", user_id: "2", drive_id: "d1", path: "photos", permission: "write" },
    ]);
    expect(grants).toHaveLength(1);
    expect(canWriteOnPath(grants, "d1", "photos/dcim/x.jpg")).toBe(true);
    expect(canWriteOnPath(grants, "d1", "other")).toBe(false);
  });

  it("detects write access anywhere on a drive", () => {
    const grants = [
      { id: "r", user_id: "2", drive_id: "d1", path: "album", permission: "read" },
      { id: "w", user_id: "2", drive_id: "d2", path: "notes", permission: "write" },
    ];
    expect(hasWriteOnDrive(grants, "d1")).toBe(false);
    expect(hasWriteOnDrive(grants, "d2")).toBe(true);
  });
});
