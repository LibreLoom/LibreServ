import { describe, expect, it } from "vitest";
import { blankDocx, blankOfficeStub, blankPptx, blankXlsx, buildStoreZip } from "./officeStubs.js";
import { listZipEntries } from "./archiveReader.js";

describe("officeStubs", () => {
  it("builds a store-method zip with the requested entries", () => {
    const blob = buildStoreZip([
      ["hello.txt", "hi"],
      ["dir/a.txt", "abc"],
    ]);
    return blob.arrayBuffer().then((buf) => {
      const entries = listZipEntries(buf);
      expect(entries.map((e) => e.name).sort()).toEqual(["dir/a.txt", "hello.txt"]);
    });
  });

  it("makes openable OOXML stubs with required parts", async () => {
    for (const [stub, required] of [
      ["docx", ["[Content_Types].xml", "word/document.xml"]],
      ["xlsx", ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]],
      ["pptx", ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide1.xml"]],
    ]) {
      const blob = blankOfficeStub(/** @type {"docx"|"xlsx"|"pptx"} */ (stub));
      const buf = await blob.arrayBuffer();
      const magic = new Uint8Array(buf, 0, 4);
      expect(Array.from(magic)).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const names = listZipEntries(buf).map((e) => e.name);
      for (const part of required) {
        expect(names).toContain(part);
      }
    }
  });

  it("exposes typed helpers", async () => {
    expect((await blankDocx().arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await blankXlsx().arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await blankPptx().arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
});
