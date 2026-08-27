import { describe, expect, it } from "vitest";
import { describeCounts, describeInspectSummary } from "./fileCounts.js";

describe("describeCounts", () => {
  it("uses singular for one folder or file", () => {
    expect(describeCounts(1, 0)).toBe("1 folder");
    expect(describeCounts(0, 1)).toBe("1 file");
    expect(describeCounts(1, 1)).toBe("1 folder and 1 file");
  });

  it("uses plural otherwise", () => {
    expect(describeCounts(2, 3)).toBe("2 folders and 3 files");
    expect(describeCounts(0, 0)).toBe("nothing yet");
  });
});

describe("describeInspectSummary", () => {
  it("writes a clear sentence with grammar", () => {
    expect(describeInspectSummary({ folders: 1, files: 2 })).toBe(
      "We found 1 folder and 2 files on this drive.",
    );
    expect(describeInspectSummary({ folders: 12, files: 7 })).toBe(
      "We found 12 folders and 7 files on this drive.",
    );
    expect(describeInspectSummary({ folders: 0, files: 0 })).toBe(
      "This drive looks empty.",
    );
  });

  it("mentions unreadable entries", () => {
    expect(describeInspectSummary({ folders: 1, files: 0, unreadable: 2 })).toBe(
      "We found 1 folder on this drive (2 could not be read).",
    );
  });
});
