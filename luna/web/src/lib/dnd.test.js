import { describe, expect, it } from "vitest";
import {
  LUNA_DRIVE_MIME,
  LUNA_PATHS_MIME,
  hasLunaPaths,
  hasOsFiles,
  readLunaDrive,
  readLunaPaths,
} from "./dnd.js";

const drag = (types, data = {}) => ({
  dataTransfer: /** @type {any} */ ({ types, getData: (type) => data[type] ?? "" }),
});

describe("hasLunaPaths / hasOsFiles", () => {
  it("tells an internal file drag from an OS upload drag", () => {
    expect(hasLunaPaths(drag([LUNA_PATHS_MIME]))).toBe(true);
    expect(hasLunaPaths(drag(["Files"]))).toBe(false);
    expect(hasOsFiles(drag(["Files"]))).toBe(true);
    expect(hasOsFiles(drag([LUNA_PATHS_MIME]))).toBe(false);
  });

  it("treats a drag with no data transfer as neither", () => {
    expect(hasLunaPaths({})).toBe(false);
    expect(hasLunaPaths({ dataTransfer: null })).toBe(false);
    expect(hasOsFiles({})).toBe(false);
  });
});

describe("readLunaPaths", () => {
  it("returns the dragged paths", () => {
    const dt = drag([LUNA_PATHS_MIME], { [LUNA_PATHS_MIME]: JSON.stringify(["a.txt", "b/c.txt"]) }).dataTransfer;
    expect(readLunaPaths(dt)).toEqual(["a.txt", "b/c.txt"]);
  });

  it("falls back when the payload is missing, malformed or not a list", () => {
    const fallback = ["kept.txt"];
    expect(readLunaPaths(null, fallback)).toBe(fallback);
    expect(readLunaPaths(drag([]).dataTransfer, fallback)).toBe(fallback);
    expect(readLunaPaths(drag([], { [LUNA_PATHS_MIME]: "{not json" }).dataTransfer, fallback)).toBe(fallback);
    expect(readLunaPaths(drag([], { [LUNA_PATHS_MIME]: '{"a":1}' }).dataTransfer, fallback)).toBe(fallback);
    expect(readLunaPaths(null)).toEqual([]);
  });
});

describe("readLunaDrive", () => {
  it("returns the source drive, or undefined when there is none", () => {
    expect(readLunaDrive(drag([], { [LUNA_DRIVE_MIME]: "d1" }).dataTransfer)).toBe("d1");
    expect(readLunaDrive(drag([]).dataTransfer)).toBeUndefined();
    expect(readLunaDrive(undefined)).toBeUndefined();
  });
});
