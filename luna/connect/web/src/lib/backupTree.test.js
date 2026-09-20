import { describe, expect, it } from "vitest";
import { filesInFolder, fmtSize, listBackupFolder, parentPath } from "./backupTree.js";

const objects = [
  { device_id: "d1", relative_path: "Photos/album/beach.jpg", size: 2000, updated_at: 1700000000 },
  { device_id: "d1", relative_path: "Photos/a.jpg", size: 100, updated_at: 1700001000 },
  { device_id: "d1", relative_path: "notes.txt", size: 12, updated_at: 1700002000 },
];

describe("backupTree", () => {
  it("lists folders and root files", () => {
    const rows = listBackupFolder(objects, "");
    expect(rows.map((r) => r.name)).toEqual(["Photos", "notes.txt"]);
    expect(rows[0].kind).toBe("dir");
    expect(rows[0].fileCount).toBe(2);
    expect(rows[0].size).toBe(2100);
    expect(rows[1].kind).toBe("file");
  });

  it("opens a folder", () => {
    const rows = listBackupFolder(objects, "Photos");
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(["dir:album", "file:a.jpg"]);
    expect(rows[1].device_id).toBe("d1");
    expect(rows[1].relative_path).toBe("Photos/a.jpg");
  });

  it("opens a nested folder", () => {
    const rows = listBackupFolder(objects, "Photos/album");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("beach.jpg");
  });

  it("lists files in a folder recursively", () => {
    expect(filesInFolder(objects, "Photos", { recursive: true })).toHaveLength(2);
    expect(filesInFolder(objects, "Photos", { recursive: false })).toHaveLength(1);
    expect(filesInFolder(objects, "", { recursive: true })).toHaveLength(3);
  });

  it("walks parents and formats size", () => {
    expect(parentPath("")).toBeNull();
    expect(parentPath("Photos/album")).toBe("Photos");
    expect(fmtSize(2000)).toBe("2.0 KB");
  });
});
