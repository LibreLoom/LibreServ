import { describe, expect, it } from "vitest";
import { canViewerOpen, officeConversionFor } from "./officeConvert.js";
import { buildStoreZip } from "./officeStubs.js";
import { listZipEntries, readZipEntry } from "./archiveReader.js";

/** @param {Blob} blob @param {RegExp} nameRe */
async function zipEntryText(blob, nameRe) {
  const buf = await blob.arrayBuffer();
  const entry = listZipEntries(buf).find((e) => nameRe.test(e.name));
  if (!entry) throw new Error(`no zip entry matching ${nameRe}`);
  return new TextDecoder().decode(await readZipEntry(buf, entry));
}

describe("officeConversionFor", () => {
  it("maps convertible preview kinds to their office target", () => {
    for (const [path, kind, ext] of [
      ["docs/budget.csv", "csv", "xlsx"],
      ["docs/notes.txt", "text", "docx"],
      ["docs/readme.md", "markdown", "docx"],
      ["books/novel.epub", "ebook", "docx"],
      ["nb/lab.ipynb", "notebook", "docx"],
      ["map/trip.geojson", "geo", "docx"],
      ["cal/work.ics", "calendar", "docx"],
      ["people/alice.vcf", "contact", "docx"],
    ]) {
      const conv = officeConversionFor(path, kind);
      expect(conv?.targetExt, path).toBe(ext);
      expect(conv?.convert, path).toBeTypeOf("function");
    }
  });

  it("marks pdf as adjacent but not convertible in the browser", () => {
    const conv = officeConversionFor("scan.pdf", "pdf");
    expect(conv?.targetExt).toBe("docx");
    expect(conv?.convert).toBeUndefined();
  });

  it("hints office-adjacent formats that have no preview kind", () => {
    for (const [name, ext] of [
      ["old.doc", "docx"],
      ["deck.key", "pptx"],
      ["sheet.numbers", "xlsx"],
      ["report.pages", "docx"],
    ]) {
      const conv = officeConversionFor(name, null);
      expect(conv?.targetExt, name).toBe(ext);
      expect(conv?.convert, name).toBeUndefined();
    }
  });

  it("returns null for files with no office-adjacent format", () => {
    expect(officeConversionFor("photo.png", "image")).toBeNull();
    expect(officeConversionFor("clip.mp4", "video")).toBeNull();
    expect(officeConversionFor("mesh.stl", null)).toBeNull();
    expect(officeConversionFor("app.zip", "archive")).toBeNull();
  });
});

describe("canViewerOpen", () => {
  it("opens real previews and office-adjacent hint cards", () => {
    expect(canViewerOpen("a.csv")).toBe(true);
    expect(canViewerOpen("a.doc")).toBe(true);
    expect(canViewerOpen("a.stl")).toBe(false);
  });
});

describe("converters", () => {
  it("csv → xlsx writes real rows with numeric cells", async () => {
    const conv = officeConversionFor("budget.csv", "csv");
    const blob = await conv.convert(
      new TextEncoder().encode("Name,Qty\nApples,4\nPears,2\n").buffer,
      "csv",
    );
    const sheet = await zipEntryText(blob, /xl\/worksheets\/sheet1\.xml$/);
    expect(sheet).toContain('<c r="A1"');
    expect(sheet).toContain("Apples");
    // 4 is a plain number → numeric cell, not an inline string.
    expect(sheet).toContain('<c r="B2"><v>4</v></c>');
    expect(sheet).not.toContain("sharedStrings");
  });

  it("keeps code-like strings as text cells", async () => {
    const conv = officeConversionFor("codes.csv", "csv");
    const blob = await conv.convert(
      new TextEncoder().encode("SKU\n007\n").buffer,
      "csv",
    );
    const sheet = await zipEntryText(blob, /xl\/worksheets\/sheet1\.xml$/);
    expect(sheet).toContain("007");
    expect(sheet).not.toContain("<v>007</v>");
  });

  it("text → docx writes each line as a paragraph", async () => {
    const conv = officeConversionFor("notes.txt", "text");
    const blob = await conv.convert(
      new TextEncoder().encode("first\nsecond\n").buffer,
      "txt",
    );
    const doc = await zipEntryText(blob, /word\/document\.xml$/);
    expect(doc).toContain("first");
    expect(doc).toContain("second");
  });

  it("epub → docx strips xhtml chapters to paragraphs", async () => {
    const epub = buildStoreZip([
      ["OEBPS/ch1.xhtml", "<html><body><h1>Title</h1><p>Hello <b>world</b>.</p></body></html>"],
    ]);
    const conv = officeConversionFor("novel.epub", "ebook");
    const blob = await conv.convert(await epub.arrayBuffer(), "epub");
    const doc = await zipEntryText(blob, /word\/document\.xml$/);
    expect(doc).toContain("Title");
    expect(doc).toContain("Hello world.");
    expect(doc).not.toContain("<b>");
  });

  it("ics → docx lists events", async () => {
    const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Dentist\nDTSTART:20260101T090000\nLOCATION:Clinic\nEND:VEVENT\nEND:VCALENDAR\n";
    const conv = officeConversionFor("cal.ics", "calendar");
    const blob = await conv.convert(new TextEncoder().encode(ics).buffer, "ics");
    const doc = await zipEntryText(blob, /word\/document\.xml$/);
    expect(doc).toContain("Dentist");
    expect(doc).toContain("Starts: 20260101T090000");
  });
});
