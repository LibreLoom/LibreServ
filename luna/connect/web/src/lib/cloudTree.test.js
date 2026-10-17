import { describe, expect, it } from "vitest";
import {
  baseName,
  filesUnder,
  formatSize,
  listFolder,
  parentFolder,
  versionLabel,
} from "./cloudTree.js";

const entries = [
  { path: "readme.txt", size: 10, mtime: 1700000000, chunks: [] },
  { path: "docs/a.txt", size: 100, mtime: 1700000000, chunks: [] },
  { path: "docs/sub/b.txt", size: 400, mtime: 1700000000, chunks: [] },
  { path: "docs/sub/c.txt", size: 500, mtime: 1700000000, chunks: [] },
  { path: "photos/10.jpg", size: 2000, mtime: 1700000000, chunks: [] },
  { path: "photos/2.jpg", size: 3000, mtime: 1700000000, chunks: [] },
];

describe("cloudTree paths", () => {
  it("finds the parent folder and base name", () => {
    expect(parentFolder("docs/sub/b.txt")).toBe("docs/sub");
    expect(parentFolder("readme.txt")).toBe("");
    expect(baseName("docs/sub/b.txt")).toBe("b.txt");
    expect(baseName("readme.txt")).toBe("readme.txt");
  });
});

describe("listFolder", () => {
  it("lists the top level with folder sums and root files", () => {
    const { folders, files } = listFolder(entries, "");
    expect(folders.map((f) => f.name)).toEqual(["docs", "photos"]);
    expect(folders[0]).toEqual({ name: "docs", path: "docs", size: 1000, files: 3 });
    expect(folders[1]).toEqual({ name: "photos", path: "photos", size: 5000, files: 2 });
    expect(files.map((f) => f.name)).toEqual(["readme.txt"]);
    expect(files[0].path).toBe("readme.txt");
    expect(files[0].size).toBe(10);
  });

  it("lists one folder down with its subfolders", () => {
    const { folders, files } = listFolder(entries, "docs");
    expect(folders).toEqual([{ name: "sub", path: "docs/sub", size: 900, files: 2 }]);
    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(files[0].path).toBe("docs/a.txt");
  });

  it("sorts names numerically", () => {
    const { files } = listFolder(entries, "photos");
    expect(files.map((f) => f.name)).toEqual(["2.jpg", "10.jpg"]);
  });
});

describe("filesUnder", () => {
  it("returns every entry below a folder", () => {
    expect(filesUnder(entries, "docs").map((e) => e.path)).toEqual([
      "docs/a.txt",
      "docs/sub/b.txt",
      "docs/sub/c.txt",
    ]);
  });

  it("returns all entries for the top level", () => {
    expect(filesUnder(entries, "")).toHaveLength(entries.length);
  });
});

describe("formatSize", () => {
  it("formats sizes with 1000-based units", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1500)).toBe("1.5 KB");
    expect(formatSize(12_000_000)).toBe("12 MB");
    expect(formatSize(3_400_000_000)).toBe("3.4 GB");
  });

  it("does not show 1000 KB when rounding", () => {
    expect(formatSize(999_960)).toBe("1 MB");
  });
});

describe("versionLabel", () => {
  it("marks the first version as latest", () => {
    expect(versionLabel(1700000000, 0).startsWith("Latest · ")).toBe(true);
  });

  it("gives other versions just the time", () => {
    expect(versionLabel(1700000000, 1).startsWith("Latest")).toBe(false);
  });
});
