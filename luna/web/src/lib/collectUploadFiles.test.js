import { describe, expect, it, vi } from "vitest";
import {
  filesFromDataTransfer,
  filesFromFileList,
  uploadDestForFile,
} from "./collectUploadFiles.js";

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
});
