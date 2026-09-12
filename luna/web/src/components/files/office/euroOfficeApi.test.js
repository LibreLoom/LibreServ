import { describe, expect, it, vi, afterEach } from "vitest";
import {
  probeEuroOffice,
  euroOfficeDocumentType,
  EUROOFFICE_API_SRC,
} from "./euroOfficeApi.js";

describe("probeEuroOffice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects SPA HTML fallback that returns 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        expect(url).toBe(EUROOFFICE_API_SRC);
        if (opts?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("<!doctype html><html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );
    await expect(probeEuroOffice()).resolves.toBe(false);
  });

  it("accepts a JavaScript DocsAPI pack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => {
        if (opts?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("window.DocsAPI = {};", {
          status: 206,
          headers: { "content-type": "application/javascript" },
        });
      }),
    );
    await expect(probeEuroOffice()).resolves.toBe(true);
  });
});

describe("euroOfficeDocumentType", () => {
  it("maps every DocsAPI document type group", () => {
    // word
    expect(euroOfficeDocumentType("docs/a.docx")).toBe("word");
    expect(euroOfficeDocumentType("a.docm")).toBe("word");
    expect(euroOfficeDocumentType("a.fodt")).toBe("word");
    expect(euroOfficeDocumentType("a.fb2")).toBe("word");
    expect(euroOfficeDocumentType("a.epub")).toBe("word");
    expect(euroOfficeDocumentType("a.docxf")).toBe("word");
    expect(euroOfficeDocumentType("a.txt")).toBe("word");
    // cell
    expect(euroOfficeDocumentType("a.xlsx")).toBe("cell");
    expect(euroOfficeDocumentType("a.xlsb")).toBe("cell");
    expect(euroOfficeDocumentType("a.ots")).toBe("cell");
    expect(euroOfficeDocumentType("a.tsv")).toBe("cell");
    expect(euroOfficeDocumentType("a.numbers")).toBe("cell");
    // slide
    expect(euroOfficeDocumentType("a.pptx")).toBe("slide");
    expect(euroOfficeDocumentType("a.ppsm")).toBe("slide");
    expect(euroOfficeDocumentType("a.otp")).toBe("slide");
    expect(euroOfficeDocumentType("a.key")).toBe("slide");
    // pdf editor (also handles djvu/xps/oxps)
    expect(euroOfficeDocumentType("a.pdf")).toBe("pdf");
    expect(euroOfficeDocumentType("a.djvu")).toBe("pdf");
    expect(euroOfficeDocumentType("a.xps")).toBe("pdf");
    expect(euroOfficeDocumentType("a.oxps")).toBe("pdf");
    // visio editor
    expect(euroOfficeDocumentType("a.vsdx")).toBe("diagram");
    expect(euroOfficeDocumentType("a.vssm")).toBe("diagram");
  });

  it("is case-insensitive and returns null for non-office formats", () => {
    expect(euroOfficeDocumentType("Brief.DOCX")).toBe("word");
    expect(euroOfficeDocumentType("Scan.PDF")).toBe("pdf");
    expect(euroOfficeDocumentType("photo.png")).toBeNull();
    expect(euroOfficeDocumentType("pack.zip")).toBeNull();
    expect(euroOfficeDocumentType("noext")).toBeNull();
    expect(euroOfficeDocumentType("")).toBeNull();
  });
});
