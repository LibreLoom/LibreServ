import { describe, expect, it, vi } from "vitest";
import {
  filesFromDataTransfer,
  filesFromFileList,
  takeDropped,
  uploadDestForFile,
  walkDropped,
} from "./collectUploadFiles.js";

/** @returns {any} */
const fileEntry = (name, file = new File(["x"], name)) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(file),
});
/** @returns {any} */
const brokenFileEntry = (name) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (_ok, fail) => fail(new Error("unreadable")),
});
/** A directory whose readEntries hands out `batches` one call at a time. */
/** @returns {any} */
const dirEntry = (name, batches) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    const queue = [...batches, []];
    return { readEntries: (ok) => ok(queue.shift()) };
  },
});

describe("collectUploadFiles", () => {
  it("reads a FileList-like list", () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    expect(filesFromFileList([a, b])).toEqual([a, b]);
  });

  it("nests webkitRelativePath under the destination folder", () => {
    const file = new File(["x"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "Docs/note.txt" });
    expect(uploadDestForFile("Inbox", file)).toEqual({
      destPath: "Inbox/Docs",
      name: "note.txt",
    });
    expect(uploadDestForFile("", file)).toEqual({
      destPath: "Docs",
      name: "note.txt",
    });
  });

  it("expands DataTransfer items via webkitGetAsEntry when present", async () => {
    const file = new File(["hi"], "hi.txt");
    const entry = {
      isFile: true,
      isDirectory: false,
      file: (ok) => ok(file),
    };
    const dataTransfer = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => entry,
          getAsFile: () => file,
        },
      ],
      files: [],
    };
    const out = await filesFromDataTransfer(/** @type {any} */ (dataTransfer));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("hi.txt");
  });

  it("falls back to DataTransfer.files", async () => {
    const file = new File(["z"], "z.txt");
    const out = await filesFromDataTransfer(
      /** @type {any} */ ({ items: null, files: [file] }),
    );
    expect(out).toEqual([file]);
  });

  it("takeDropped reads entries and falls back to files", () => {
    const entry = fileEntry("a.txt");
    const got = takeDropped(
      /** @type {any} */ ({
        items: [{ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null }],
        files: [],
      }),
    );
    expect(got.entries).toEqual([entry]);
    const f = new File(["z"], "z.txt");
    expect(takeDropped(/** @type {any} */ ({ items: null, files: [f] }))).toEqual({ entries: [], files: [f] });
    expect(takeDropped(null)).toEqual({ entries: [], files: [] });
  });

  it("walkDropped reports nested files with the dropped folder name first, in batches", async () => {
    const root = dirEntry("Docs", [
      [fileEntry("a.txt"), dirEntry("sub", [[fileEntry("b.txt")]])],
      [fileEntry("c.txt")],
    ]);
    const seen = [];
    await walkDropped({ entries: [root], files: [] }, { onFile: (_f, rel) => seen.push(rel) });
    expect(seen).toEqual(["Docs/a.txt", "Docs/sub/b.txt", "Docs/c.txt"]);
  });

  it("walkDropped reports empty folders through onDir", async () => {
    const onDir = vi.fn();
    await walkDropped(
      { entries: [dirEntry("Empty", [])], files: [] },
      { onFile: vi.fn(), onDir },
    );
    expect(onDir).toHaveBeenCalledWith("Empty");
  });

  it("walkDropped keeps going when one entry can't be read", async () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    const root = dirEntry("Docs", [[fileEntry("a.txt"), brokenFileEntry("bad.txt"), fileEntry("c.txt")]]);
    await walkDropped({ entries: [root], files: [] }, { onFile, onError });
    expect(onFile.mock.calls.map((c) => c[1])).toEqual(["Docs/a.txt", "Docs/c.txt"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("Docs/bad.txt");
  });

  it("walkDropped uses webkitRelativePath for picked folders and stops on abort", async () => {
    const picked = new File(["x"], "n.txt");
    Object.defineProperty(picked, "webkitRelativePath", { value: "Pick/n.txt" });
    const seen = [];
    await walkDropped({ entries: [], files: [picked] }, { onFile: (_f, rel) => seen.push(rel) });
    expect(seen).toEqual(["Pick/n.txt"]);

    const controller = new AbortController();
    controller.abort();
    const onFile = vi.fn();
    await walkDropped({ entries: [fileEntry("a.txt")], files: [] }, { onFile, signal: controller.signal });
    expect(onFile).not.toHaveBeenCalled();
  });
});
