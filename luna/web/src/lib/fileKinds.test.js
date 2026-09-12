import { describe, expect, it } from "vitest";
import {
  isArchiveFile,
  isAudioFile,
  isCadFile,
  isComicFile,
  isImageFile,
  isMarkdownFile,
  isOfficeFile,
  isPdfFile,
  isTextFile,
  isVideoFile,
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

  it("opens audio, archives, office, and marks CAD download-only", () => {
    expect(isPdfFile("report.PDF")).toBe(true);
    expect(isAudioFile("song.mp3")).toBe(true);
    expect(isArchiveFile("pack.zip")).toBe(true);
    expect(isArchiveFile("src.tar.gz")).toBe(true);
    expect(isOfficeFile("Brief.docx")).toBe(true);
    expect(isOfficeFile("Budget.csv")).toBe(true);
    expect(isComicFile("issue.cbz")).toBe(true);
    expect(isCadFile("part.stl")).toBe(true);
    expect(openableKind("song.flac")).toBe("audio");
    expect(openableKind("pack.zip")).toBe("archive");
    expect(openableKind("deck.pptx")).toBe("office");
    expect(openableKind("budget.csv")).toBe("office");
    expect(openableKind("notes.ipynb")).toBe("notebook");
    expect(openableKind("meet.ics")).toBe("calendar");
    expect(openableKind("ada.vcf")).toBe("contact");
    expect(openableKind("font.woff2")).toBe("font");
    expect(openableKind("map.geojson")).toBe("geo");
    expect(openableKind("part.stl")).toBe("cad");
    expect(openableKind("mystery.bin")).toBe(null);
  });

  it("routes every EuroOffice-supported format to the office editor", () => {
    // Mirrors the fileType list in dev/eurooffice api.js. pdf/epub keep their
    // own viewers only as fallback when the EuroOffice pack is missing.
    const officeNames = [
      // word
      "a.doc", "a.docx", "a.docm", "a.dot", "a.dotx", "a.dotm",
      "a.odt", "a.fodt", "a.ott", "a.sxw", "a.stw",
      "a.rtf", "a.epub", "a.fb2", "a.mht", "a.mhtml",
      "a.wps", "a.wpt", "a.hwp", "a.hwpx", "a.hml", "a.pages",
      "a.oform", "a.docxf", "a.gdoc",
      // spreadsheet
      "a.xls", "a.xlsx", "a.xlsm", "a.xlsb", "a.xlt", "a.xltx", "a.xltm",
      "a.ods", "a.fods", "a.ots", "a.sxc",
      "a.csv", "a.tsv", "a.et", "a.ett", "a.numbers", "a.gsheet",
      // presentation
      "a.ppt", "a.pptx", "a.pptm", "a.pps", "a.ppsx", "a.ppsm",
      "a.pot", "a.potx", "a.potm",
      "a.odp", "a.fodp", "a.otp", "a.sxi", "a.odg",
      "a.dps", "a.dpt", "a.key", "a.gslides",
      // pdf + fixed-layout
      "a.pdf", "a.djvu", "a.xps", "a.oxps",
      // diagrams
      "a.vsdx", "a.vssx", "a.vstx", "a.vsdm", "a.vssm", "a.vstm",
    ];
    for (const name of officeNames) {
      expect(openableKind(name)).toBe("office");
      expect(isOfficeFile(name)).toBe(true);
    }
    expect(openableKind("report.pdf")).toBe("office");
    expect(openableKind("book.epub")).toBe("office");
    expect(openableKind("table.tsv")).toBe("office");
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
