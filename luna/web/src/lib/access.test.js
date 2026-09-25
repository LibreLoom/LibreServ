import { describe, expect, it } from "vitest";
import {
  CAP,
  capsBits,
  capsCover,
  capsHint,
  capsLabel,
  capsOptions,
  hasCap,
  shareSubjectFromRow,
  sharedItemHref,
  subjectKey,
  subjectQuery,
} from "./access.js";

describe("capsBits / capsCover / hasCap", () => {
  it("maps wire names to bits", () => {
    expect(capsBits("view")).toBe(CAP.VIEW);
    expect(capsBits("upload")).toBe(CAP.UPLOAD);
    expect(capsBits("view+upload")).toBe(CAP.VIEW | CAP.UPLOAD);
    expect(capsBits("full")).toBe(CAP.VIEW | CAP.UPLOAD | CAP.EDIT);
    expect(capsBits("respond")).toBe(CAP.RESPOND);
    expect(capsBits("bogus")).toBe(0);
    expect(capsBits(null)).toBe(0);
  });

  it("covers subsets, not siblings", () => {
    expect(capsCover("full", "view")).toBe(true);
    expect(capsCover("full", "view+upload")).toBe(true);
    expect(capsCover("view+upload", "view")).toBe(true);
    expect(capsCover("view+upload", "upload")).toBe(true);
    expect(capsCover("view", "upload")).toBe(false);
    expect(capsCover("upload", "view")).toBe(false);
    expect(capsCover("view+upload", "full")).toBe(false);
    expect(capsCover("view", "respond")).toBe(false);
    expect(capsCover("view+upload", "respond")).toBe(false);
  });

  it("hasCap reads single bits", () => {
    expect(hasCap("view+upload", CAP.UPLOAD)).toBe(true);
    expect(hasCap("view+upload", CAP.EDIT)).toBe(false);
    expect(hasCap("upload", CAP.VIEW)).toBe(false);
  });
});

describe("capsOptions — only valid, covered choices", () => {
  const folder = { kind: "path", isFile: false };
  const file = { kind: "path", isFile: true };
  const album = { kind: "album" };

  it("a file never offers upload-only (the reported bug)", () => {
    const values = capsOptions(file, "full").map((o) => o.value);
    expect(values).toEqual(["view", "full"]);
    expect(values).not.toContain("upload");
  });

  it("a folder offers the four levels in order", () => {
    expect(capsOptions(folder, "full").map((o) => o.value)).toEqual([
      "view",
      "upload",
      "view+upload",
      "full",
    ]);
  });

  it("an album offers view and view+add only", () => {
    expect(capsOptions(album, "full").map((o) => o.value)).toEqual([
      "view",
      "view+upload",
    ]);
  });

  it("a member can only offer subsets of what they hold", () => {
    expect(capsOptions(folder, "view").map((o) => o.value)).toEqual(["view"]);
    expect(capsOptions(folder, "view+upload").map((o) => o.value)).toEqual([
      "view",
      "upload",
      "view+upload",
    ]);
    expect(capsOptions(folder, "upload").map((o) => o.value)).toEqual(["upload"]);
    expect(capsOptions(folder, "view").map((o) => o.value)).not.toContain("full");
  });

  it("a form file can offer Collect answers on links when the holder can write", () => {
    const form = { kind: "path", isFile: true, isForm: true };
    const linkOpts = capsOptions(form, "full", { forLink: true }).map((o) => o.value);
    expect(linkOpts).toContain("respond");
    expect(linkOpts[0]).toBe("respond");
    // Members never get respond — it's link-only.
    const memberOpts = capsOptions(form, "full").map((o) => o.value);
    expect(memberOpts).not.toContain("respond");
    // View-only holders can't mint respond links.
    const viewOnly = capsOptions(form, "view", { forLink: true }).map((o) => o.value);
    expect(viewOnly).not.toContain("respond");
  });
});

describe("labels and hints", () => {
  it("uses plain names", () => {
    expect(capsLabel("view")).toBe("Can view");
    expect(capsLabel("upload")).toBe("Upload only");
    expect(capsLabel("view+upload")).toBe("Can view + upload");
    expect(capsLabel("view+upload", { album: true })).toBe("Can view + add photos");
    expect(capsLabel("full")).toBe("Can view + edit");
    expect(capsLabel("respond")).toBe("Collect answers");
  });

  it("describes full access honestly for files vs folders", () => {
    expect(capsHint("full", { file: true })).toBe("Opens, edits, and replaces this file.");
    expect(capsHint("full")).toBe("Opens, edits, uploads, renames, moves, and deletes files.");
    expect(capsHint("upload")).toBe("Uploads files without seeing anything already here.");
  });

  it("says what form links expose — answers come with view and full", () => {
    expect(capsHint("view", { file: true, form: true }))
      .toBe("Opens the form and its responses.");
    expect(capsHint("full", { file: true, form: true }))
      .toBe("Edits the form and reads its responses.");
    // Respond copy is unchanged — answer links still never see others'.
    expect(capsHint("respond", { form: true }))
      .toBe("People fill in the form — they never see other answers or the file itself.");
    // And non-form copy is untouched by the flag's default.
    expect(capsHint("view", { file: true })).toBe("Opens and downloads the file.");
  });
});

describe("sharedItemHref / shareSubjectFromRow", () => {
  const folderRow = {
    kind: "path", drive_id: "d1", path: "docs", is_file: false, name: "docs",
  };
  const fileRow = {
    kind: "path", drive_id: "d1", path: "docs/report.pdf", is_file: true, name: "report.pdf",
  };
  const albumRow = {
    kind: "album", drive_id: "d1", album_id: "al 1", is_file: false, name: "Beach",
  };

  it("opens a folder at the folder", () => {
    expect(sharedItemHref(folderRow)).toBe("/drives/d1?path=docs");
  });

  it("opens a whole-drive grant at the drive root", () => {
    expect(sharedItemHref({ ...folderRow, path: "" })).toBe("/drives/d1");
  });

  it("opens a file at the file itself, not its folder", () => {
    expect(sharedItemHref(fileRow)).toBe("/drives/d1?path=docs&file=report.pdf");
  });

  it("opens an album in the gallery", () => {
    expect(sharedItemHref(albumRow)).toBe("/gallery#albums/d1/al%201");
  });

  it("maps a member row to a share subject", () => {
    expect(shareSubjectFromRow(fileRow)).toEqual({
      kind: "path", driveId: "d1", path: "docs/report.pdf", albumId: "",
      isFile: true, name: "report.pdf",
    });
    expect(shareSubjectFromRow(albumRow)).toEqual({
      kind: "album", driveId: "d1", path: "", albumId: "al 1",
      isFile: false, name: "Beach",
    });
  });
});

describe("subject query/key", () => {
  it("encodes path subjects", () => {
    const q = subjectQuery({ kind: "path", driveId: "d1", path: "a/b" });
    expect(q).toBe("kind=path&drive_id=d1&path=a%2Fb");
    expect(subjectKey({ kind: "path", driveId: "d1", path: "a/b" }))
      .toEqual(["path", "d1", "a/b", ""]);
  });

  it("encodes album subjects", () => {
    const q = subjectQuery({ kind: "album", driveId: "d1", albumId: "al9" });
    expect(q).toBe("kind=album&drive_id=d1&album_id=al9");
    expect(subjectKey({ kind: "album", driveId: "d1", albumId: "al9" }))
      .toEqual(["album", "d1", "", "al9"]);
  });
});
