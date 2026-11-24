import { describe, expect, it } from "vitest";
import { clockSkew, needsFreshPreview, phaseLabel, previewHeadline, secondsUntil, startErrorMessage } from "./driveFormat.js";

describe("driveFormat", () => {
  it("counts the wait on the server's clock", () => {
    const skew = clockSkew(1000, 1_000_000 + 3_600_000); // this browser is an hour ahead
    expect(secondsUntil(1030, skew, 1_000_000 + 3_600_000)).toBe(30);
    expect(secondsUntil(1030, skew, 1_000_000 + 3_600_000 + 29_500)).toBe(1);
    expect(secondsUntil(1030, skew, 1_000_000 + 3_600_000 + 31_000)).toBe(0);
  });

  it("gives every start error code one plain sentence", () => {
    for (const code of ["format_not_ready", "preview_expired", "preview_not_found", "drive_busy", "drive_changed", "preview_stale", "missing_tool", "mock_encryption"]) {
      const text = startErrorMessage({ code, message: "raw" }, "fallback");
      expect(text).not.toBe("raw");
      expect(text).not.toBe("fallback");
      expect(text.endsWith(".")).toBe(true);
    }
    expect(startErrorMessage({ code: "weak_password", message: "Enter a password for this drive." }, "x")).toBe("Enter a password for this drive.");
    expect(startErrorMessage({ code: "other", message: "Server words." }, "x")).toBe("Server words.");
    expect(startErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("offers a fresh look for expired, missing, changed and stale previews only", () => {
    for (const code of ["preview_expired", "preview_not_found", "drive_changed", "preview_stale"]) expect(needsFreshPreview({ code })).toBe(true);
    for (const code of ["drive_busy", "format_not_ready", "missing_tool", null]) expect(needsFreshPreview({ code })).toBe(false);
  });

  it("names every phase lunad sends", () => {
    for (const p of ["preparing", "releasing", "erasing", "partitioning", "encrypting", "formatting", "registering"]) {
      expect(phaseLabel(p)).not.toBe("Working");
    }
    expect(phaseLabel("something new")).toBe("Working");
  });

  it("words the headline from the server's verdict", () => {
    expect(previewHeadline({ empty: true, blank: true, partitions: [] }).title).toBe("This drive is blank.");
    expect(previewHeadline({ empty: false, partitions: [{ state: "unreadable" }] }).title).toBe("Luna can't read this drive.");
    expect(previewHeadline({ empty: false, partitions: [{ state: "installer_media" }] }).title).toBe("This looks like an installer disk.");
    expect(previewHeadline({ empty: false, partitions: [{ state: "has_files" }, { state: "locked" }] }).title).toBe("This drive has files on it.");
  });
});
