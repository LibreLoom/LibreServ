import { describe, expect, it } from "vitest";
import {
  isArchiveFile,
  isAudioFile,
  isComicFile,
  isCsvFile,
  isDiagramFile,
  isFormFile,
  isImageFile,
  isMarkdownFile,
  isOfficeFile,
  isPdfFile,
  isTextFile,
  isVideoFile,
  OFFICE_FORMATS,
  OFFICE_SAVE_EXT,
  openableKind,
} from "./fileKinds.js";

describe("fileKinds", () => {
  it("classifies images, video, and text", () => {
    expect(isImageFile("DCIM/a.JPG")).toBe(true);
    expect(isVideoFile("clip.mp4")).toBe(true);
    expect(isTextFile("notes.txt")).toBe(true);
    expect(isTextFile("README")).toBe(true);
    expect(openableKind("photo.png")).toBe("image");
    expect(openableKind("movie.webm")).toBe("video");
    expect(openableKind("todo.md")).toBe("markdown");
    expect(openableKind("Notes.MARKDOWN")).toBe("markdown");
  });

  it("classifies markdown as its own kind, not text", () => {
    expect(isMarkdownFile("notes.md")).toBe(true);
    expect(isMarkdownFile("a/b/c/file.markdown")).toBe(true);
    expect(isMarkdownFile("note.txt")).toBe(false);
    expect(isTextFile("notes.md")).toBe(false);
    expect(isTextFile("notes.txt")).toBe(true);
  });

  it("opens audio, archives, office, csv, and preview kinds", () => {
    expect(isPdfFile("report.PDF")).toBe(true);
    expect(isAudioFile("song.mp3")).toBe(true);
    expect(isArchiveFile("pack.zip")).toBe(true);
    expect(isArchiveFile("src.tar.gz")).toBe(true);
    expect(isOfficeFile("Brief.docx")).toBe(true);
    expect(isCsvFile("Budget.csv")).toBe(true);
    expect(isComicFile("issue.cbz")).toBe(true);
    expect(openableKind("song.flac")).toBe("audio");
    expect(openableKind("pack.zip")).toBe("archive");
    expect(openableKind("deck.pptx")).toBe("office");
    expect(openableKind("budget.csv")).toBe("csv");
    expect(openableKind("notes.ipynb")).toBe("notebook");
    expect(openableKind("meet.ics")).toBe("calendar");
    expect(openableKind("ada.vcf")).toBe("contact");
    expect(openableKind("font.woff2")).toBe("font");
    expect(openableKind("map.geojson")).toBe("geo");
    expect(openableKind("mystery.bin")).toBe(null);
  });

  it("classifies .lunaform files as forms, never text", () => {
    expect(isFormFile("RSVP.lunaform")).toBe(true);
    expect(isFormFile("forms/family reunion.LunaForm")).toBe(true);
    expect(isFormFile("notes.txt")).toBe(false);
    expect(openableKind("rsvp.lunaform")).toBe("form");
    expect(isTextFile("rsvp.lunaform")).toBe(false);
    // The sibling answers file stays a readable text file.
    expect(openableKind("rsvp.responses.jsonl")).toBe("text");
  });

  it("classifies drawio files — including the self-previewing variants — as diagrams", () => {
    expect(isDiagramFile("flow.drawio")).toBe(true);
    expect(isDiagramFile("net/Map.DRAWIO")).toBe(true);
    expect(isDiagramFile("arch.drawio.svg")).toBe(true);
    expect(isDiagramFile("arch.drawio.png")).toBe(true);
    expect(openableKind("flow.drawio")).toBe("diagram");
    // The embedded-image variants must win over the image/text kinds they
    // would otherwise land in — the diagram is the document.
    expect(openableKind("arch.drawio.svg")).toBe("diagram");
    expect(openableKind("arch.drawio.png")).toBe("diagram");
    // A plain .svg/.png is still just an image/source file.
    expect(isDiagramFile("icon.svg")).toBe(false);
    expect(isDiagramFile("photo.png")).toBe(false);
    expect(openableKind("icon.svg")).toBe("text");
    expect(openableKind("photo.png")).toBe("image");
  });

  it("routes exactly the verified EuroOffice formats to the office editor", () => {
    // The table is the spec — every ext in it must classify as office, and
    // the real conversion check lives in office/x2tFormats.test.js.
    for (const ext of Object.keys(OFFICE_FORMATS)) {
      expect(openableKind(`a.${ext}`), `.${ext}`).toBe("office");
      expect(isOfficeFile(`a.${ext}`)).toBe(true);
    }
  });

  it("rejects formats Luna has no implemented support for", () => {
    // 3D/CAD — no renderer, previously a dead "cad" kind.
    for (const name of ["part.stl", "a.obj", "a.gltf", "a.step"]) {
      expect(openableKind(name), name).toBe(null);
    }
    // Office formats the bundled x2t can't read: doc, the cloud pointers,
    // iWork/WPS/HWP/StarOffice, diagrams, fixed-layout, mht/epub/fb2 as
    // office docs (epub still opens via the ebook kind).
    const notOffice = [
      "a.doc", "a.gdoc", "a.gsheet", "a.gslides", "a.pages", "a.numbers",
      "a.key", "a.wps", "a.et", "a.dps", "a.hwp", "a.sxw", "a.sxc", "a.sxi",
      "a.hml", "a.mht", "a.mhtml", "a.fb2", "a.vsdx", "a.vssm", "a.djvu",
      "a.xps", "a.oxps", "a.dot", "a.pot",
    ];
    for (const name of notOffice) {
      expect(isOfficeFile(name), name).toBe(false);
      expect(openableKind(name), name).toBe(null);
    }
    // pdf/epub are not office — they have their own viewers.
    expect(openableKind("report.pdf")).toBe("pdf");
    expect(openableKind("book.epub")).toBe("ebook");
    // csv/tsv preview via the table viewer, not the office converter.
    expect(openableKind("table.tsv")).toBe("csv");
    // No browser plays these; he'd see a broken <video>/<img> instead.
    expect(openableKind("movie.mkv")).toBe(null);
    expect(openableKind("pic.heic")).toBe(null);
  });

  it("keeps save capability to formats that round-trip without silent loss", () => {
    // Every saveable ext must itself be an office ext.
    for (const ext of OFFICE_SAVE_EXT) {
      expect(OFFICE_FORMATS[ext], `.${ext} in OFFICE_FORMATS`).toBeTruthy();
    }
    // View-only: macros would be stripped; flat ODF and legacy have no writer.
    for (const ext of ["docm", "dotm", "xlsm", "xltm", "pptm", "potm",
      "fodt", "fods", "fodp", "xls", "xlt", "ppt", "pps"]) {
      expect(OFFICE_SAVE_EXT.has(ext), `.${ext}`).toBe(false);
    }
  });

  it("keeps plaintext formats on the text and markdown editors", () => {
    expect(openableKind("notes.txt")).toBe("text");
    expect(openableKind("page.html")).toBe("text");
    expect(openableKind("page.htm")).toBe("text");
    expect(openableKind("data.xml")).toBe("text");
    expect(openableKind("readme.md")).toBe("markdown");
    expect(isOfficeFile("notes.txt")).toBe(false);
    expect(isOfficeFile("readme.md")).toBe(false);
    expect(isOfficeFile("page.html")).toBe(false);
  });
});
