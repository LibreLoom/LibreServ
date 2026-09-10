import { describe, expect, it } from "vitest";
import {
  isArchiveFile,
  isAudioFile,
  isCadFile,
  isComicFile,
  isImageFile,
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
    expect(openableKind("todo.md")).toBe("text");
  });

  it("opens pdf, audio, archives, office, and marks CAD download-only", () => {
    expect(isPdfFile("report.PDF")).toBe(true);
    expect(isAudioFile("song.mp3")).toBe(true);
    expect(isArchiveFile("pack.zip")).toBe(true);
    expect(isArchiveFile("src.tar.gz")).toBe(true);
    expect(isOfficeFile("Brief.docx")).toBe(true);
    expect(isComicFile("issue.cbz")).toBe(true);
    expect(isCadFile("part.stl")).toBe(true);
    expect(openableKind("report.pdf")).toBe("pdf");
    expect(openableKind("song.flac")).toBe("audio");
    expect(openableKind("pack.zip")).toBe("archive");
    expect(openableKind("deck.pptx")).toBe("office");
    expect(openableKind("notes.ipynb")).toBe("notebook");
    expect(openableKind("meet.ics")).toBe("calendar");
    expect(openableKind("ada.vcf")).toBe("contact");
    expect(openableKind("book.epub")).toBe("ebook");
    expect(openableKind("font.woff2")).toBe("font");
    expect(openableKind("map.geojson")).toBe("geo");
    expect(openableKind("part.stl")).toBe("cad");
    expect(openableKind("mystery.bin")).toBe(null);
  });
});
