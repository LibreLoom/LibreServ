import { describe, expect, it } from "vitest";
import { describeDriveHealth } from "./driveHealth";

const BASE = {
  available: true,
  reason: null,
  verdict: "ok",
  overall: "passed",
  temperature_c: 34,
  temperature_max_c: 60,
  temperature_max_source: "typical",
  reallocated_sectors: 0,
  pending_sectors: 0,
  uncorrectable_sectors: 0,
  signals: [],
};

/** d1 in the dashboard/drive-unhealthy scenario. */
const FAILING = {
  ...BASE,
  verdict: "failing",
  overall: "failed",
  temperature_c: 55,
  reallocated_sectors: 120,
  signals: [
    { kind: "self_check_failed", level: "failing", value: null, limit: null },
    { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 },
    { kind: "temperature", level: "note", value: 55, limit: 60 },
  ],
};

/** d2 in the dashboard/drive-unhealthy scenario. */
const WEAR = {
  ...BASE,
  verdict: "watch",
  temperature_c: 48,
  reallocated_sectors: 4,
  signals: [{ kind: "reallocated_sectors", level: "watch", value: 4, limit: 100 }],
};

/** Every string a copy object contains. */
function allStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

const row = (copy, key) => copy.rows.find((r) => r.key === key);

describe("describeDriveHealth", () => {
  it("says nothing for a drive that is not a hard drive", () => {
    expect(describeDriveHealth({ ...BASE, available: false, reason: "not_a_hard_drive", verdict: "unknown" })).toBeNull();
  });

  it("shows a muted checking pill while the report loads", () => {
    for (const loading of [undefined, null]) {
      const copy = describeDriveHealth(loading);
      expect(copy.verdict).toBe("checking");
      expect(copy.pill).toEqual({ variant: "muted", label: "Checking health…" });
      expect(copy.summary).toBe("Checking this drive's health…");
      expect(copy.rows).toEqual([]);
      expect(copy.needsYou).toBeNull();
    }
  });

  it("calls a healthy drive Healthy, with no Needs you row and no steps", () => {
    const copy = describeDriveHealth(BASE);
    expect(copy.pill).toEqual({ variant: "success", label: "Healthy" });
    expect(copy.summary).toBe("This hard drive reported no problems.");
    expect(copy.needsYou).toBeNull();
    expect(copy.steps).toEqual([]);
  });

  it("calls a failing drive Failing and says to copy files off now", () => {
    const copy = describeDriveHealth(FAILING);
    expect(copy.verdict).toBe("failing");
    expect(copy.pill).toEqual({ variant: "error", label: "Failing" });
    expect(copy.summary).toBe("This drive is failing. Copy your files to another drive now.");
    expect(copy.needsYou).toEqual({
      tone: "problem",
      rank: 12,
      title: " is failing",
      detail: "Its own self-check failed. Copy your files to another drive now.",
    });
    expect(copy.steps).toEqual([
      "Plug in another drive with enough free space and add it to Luna.",
      "Open this drive, tick Select all, choose Copy, and pick the new drive.",
      "When the copy is done, remove this drive from Luna and stop using it.",
    ]);
    expect(row(copy, "replaced-spots").value).toBe("120 · too many");
    expect(row(copy, "self-check").value).toBe("Failed");
    expect(row(copy, "temperature").value).toBe("55°C · warm");
  });

  it.each([
    [
      "worn_past_limit",
      { kind: "worn_past_limit", level: "failing", value: null, limit: null },
      "It's past its maker's wear limit. Copy your files to another drive now.",
    ],
    [
      "pending_sectors",
      { kind: "pending_sectors", level: "failing", value: 3, limit: null },
      "It can't read 3 spots on its disk. Copy your files to another drive now.",
    ],
    [
      "reallocated_sectors",
      { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 },
      "120 spots on its disk have worn out. Copy your files to another drive now.",
    ],
  ])("explains a failing drive by its top signal: %s", (_name, signal, detail) => {
    const copy = describeDriveHealth({ ...BASE, verdict: "failing", signals: [signal] });
    expect(copy.needsYou.detail).toBe(detail);
  });

  it("calls a worn drive Showing wear and says to keep using it and back it up", () => {
    const copy = describeDriveHealth(WEAR);
    expect(copy.verdict).toBe("watch");
    expect(copy.pill).toEqual({ variant: "warning", label: "Showing wear" });
    expect(copy.summary).toBe("Still working. Keep using it, and make sure its files are backed up.");
    expect(copy.needsYou).toEqual({
      tone: "warning",
      rank: 70,
      title: " is showing wear",
      detail: "4 spots on its disk have worn out. Keep using it, and make sure it's backed up.",
    });
    expect(copy.steps).toEqual([
      "Keep using it.",
      "Make sure its files are backed up: use the Back up button on this drive's card.",
    ]);
  });

  it("calls 48°C normal and shows it in the temperature row", () => {
    const copy = describeDriveHealth(WEAR);
    const temp = row(copy, "temperature");
    expect(temp.label).toBe("Temperature");
    expect(temp.value).toBe("48°C · normal");
    expect(temp.hint).toBe(
      "Hard drives get warm while they work. Most hard drives are made to run at up to 60°C.",
    );
  });

  it("uses the drive's own limit in the temperature hint when it gave one", () => {
    const copy = describeDriveHealth({
      ...BASE,
      temperature_c: 52,
      temperature_max_c: 70,
      temperature_max_source: "drive",
    });
    expect(row(copy, "temperature").hint).toContain("This drive says it's made to run at up to 70°C.");
  });

  it("calls a warm drive warm without changing its verdict", () => {
    const copy = describeDriveHealth({
      ...BASE,
      temperature_c: 55,
      signals: [{ kind: "temperature", level: "note", value: 55, limit: 60 }],
    });
    expect(copy.verdict).toBe("ok");
    expect(row(copy, "temperature").value).toBe("55°C · warm");
    expect(row(copy, "temperature").hint).toContain("Keep air moving around it.");
  });

  it("calls a hot drive Running hot and says to move it somewhere cooler", () => {
    const copy = describeDriveHealth({
      ...BASE,
      verdict: "watch",
      temperature_c: 61,
      signals: [{ kind: "temperature", level: "watch", value: 61, limit: 60 }],
    });
    expect(copy.pill).toEqual({ variant: "warning", label: "Running hot" });
    expect(copy.summary).toBe("Still working, but too hot. Move it somewhere cooler or give it more air.");
    expect(copy.needsYou.title).toBe(" is running hot");
    expect(copy.needsYou.detail).toBe("It's 61°C, above the 60°C it's made for. Move it somewhere cooler.");
    expect(row(copy, "temperature").value).toBe("61°C · too hot");
    expect(copy.steps).toHaveLength(3);
    expect(copy.steps[2]).toBe("Give it more air: away from heaters and out of closed cupboards.");
  });

  it.each([
    ["error_log", "Logged errors", " has logged errors"],
    ["self_test_errors", "Failed a self-test", " failed a self-test"],
    ["worn_in_past", "Showing wear", " is showing wear"],
  ])("words a watch on %s", (kind, pill, title) => {
    const copy = describeDriveHealth({
      ...BASE,
      verdict: "watch",
      signals: [{ kind, level: "watch", value: null, limit: null }],
    });
    expect(copy.pill.label).toBe(pill);
    expect(copy.needsYou.title).toBe(title);
  });

  it("explains a hard drive whose report could not be read", () => {
    const copy = describeDriveHealth({
      ...BASE,
      available: false,
      reason: "no_report",
      verdict: "unknown",
      overall: "unknown",
      temperature_c: null,
      reallocated_sectors: null,
      pending_sectors: null,
      uncorrectable_sectors: null,
    });
    expect(copy.pill).toEqual({ variant: "muted", label: "Health unknown" });
    expect(copy.summary).toBe("Luna couldn't read this hard drive's health report.");
    expect(copy.hint).toContain("Some USB cases don't pass it on.");
    expect(copy.needsYou).toBeNull();
    expect(copy.steps).toEqual([]);
    expect(row(copy, "self-check").value).toBe("Not reported");
    expect(row(copy, "temperature")).toBeUndefined();
  });

  it("shows unreadable spots as failing and adds a row for each extra signal", () => {
    const copy = describeDriveHealth({
      ...BASE,
      verdict: "failing",
      pending_sectors: 2,
      uncorrectable_sectors: 1,
      signals: [
        { kind: "pending_sectors", level: "failing", value: 2, limit: null },
        { kind: "worn_past_limit", level: "failing", value: null, limit: null },
        { kind: "error_log", level: "watch", value: null, limit: null },
        { kind: "self_test_errors", level: "watch", value: null, limit: null },
      ],
    });
    expect(row(copy, "unreadable-spots").value).toBe("3 · failing");
    expect(row(copy, "wear-limit").value).toBe("Past the maker's limit");
    expect(row(copy, "error-log").value).toBe("Has errors");
    expect(row(copy, "self-test").value).toBe("Found a problem");
  });

  it("shows None for replaced and unreadable spots on a clean drive", () => {
    const copy = describeDriveHealth(BASE);
    expect(row(copy, "replaced-spots").value).toBe("None");
    expect(row(copy, "unreadable-spots").value).toBe("None");
    expect(row(copy, "wear-limit")).toBeUndefined();
  });

  it("never uses the word smart or says needs attention in any string", () => {
    const reports = [
      undefined,
      BASE,
      FAILING,
      WEAR,
      { ...BASE, available: false, reason: "no_report", verdict: "unknown", overall: "unknown" },
    ];
    for (const report of reports) {
      for (const text of allStrings(describeDriveHealth(report))) {
        expect(text).not.toMatch(/smart/i);
        expect(text).not.toMatch(/needs attention/i);
      }
    }
  });
});
