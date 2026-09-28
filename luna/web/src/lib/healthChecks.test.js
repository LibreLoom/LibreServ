import { describe, expect, it } from "vitest";
import { displayLabel, labelFor, statusRank } from "./healthChecks.js";

describe("healthChecks", () => {
  it("labels core checks in plain language", () => {
    expect(labelFor("disk_space")).toBe("Storage space");
    expect(labelFor("data_path_writable")).toBe("Luna data folder");
    expect(labelFor("database")).toBe("Accounts and settings");
    expect(labelFor("office_pack")).toBe("Documents, spreadsheets, and presentations");
  });

  it("ranks failures before warnings before passes", () => {
    expect(statusRank("failed")).toBeLessThan(statusRank("warning"));
    expect(statusRank("warning")).toBeLessThan(statusRank("passed"));
  });

  it("uses drive labels from check details", () => {
    expect(
      displayLabel("drive_d1_smart", {
        details: { drive_label: "Family photos" },
      }),
    ).toBe("Family photos — hard drive wear");
  });
});
