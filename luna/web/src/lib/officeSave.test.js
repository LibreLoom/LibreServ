import { describe, expect, it } from "vitest";
import { canRoundTripOfficeExt, textToOfficeBlob } from "./officeSave.js";

describe("officeSave", () => {
  it("round-trips only docx xlsx pptx", () => {
    expect(canRoundTripOfficeExt("docx")).toBe(true);
    expect(canRoundTripOfficeExt(".XLSX")).toBe(true);
    expect(canRoundTripOfficeExt("pptx")).toBe(true);
    expect(canRoundTripOfficeExt("odt")).toBe(false);
    expect(canRoundTripOfficeExt("pdf")).toBe(false);
  });

  it("builds blobs for supported types", async () => {
    for (const ext of ["docx", "xlsx", "pptx"]) {
      const blob = textToOfficeBlob("Hello", ext);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(40);
      const buf = new Uint8Array(await blob.arrayBuffer());
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    }
  });

  it("refuses unsafe types", () => {
    expect(textToOfficeBlob("x", "odt")).toBeNull();
    expect(textToOfficeBlob("x", "doc")).toBeNull();
  });
});
