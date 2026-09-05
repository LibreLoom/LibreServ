import { describe, expect, it } from "vitest";
import { displayLabel, labelFor } from "./healthChecks.js";

describe("healthChecks", () => {
  it("labels core checks in plain language", () => {
    expect(labelFor("disk_space")).toBe("Storage space");
    expect(labelFor("data_path_writable")).toBe("Luna data folder");
  });

  it("uses drive labels from check details", () => {
    expect(
      displayLabel("drive_d1_smart", {
        details: { drive_label: "Family photos" },
      }),
    ).toBe("Family photos — hard drive wear");
  });
});
