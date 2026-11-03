import { describe, expect, it } from "vitest";
import { NO_ACTION_CHECKS, buildSystemCheckItems, pillChecks } from "./needsYouChecks.js";

const NO_EXCLUSIONS = { coveredDriveLabels: [], noRouteShown: false };

/**
 * @param {Record<string, any> | undefined} checks
 * @param {Partial<typeof NO_EXCLUSIONS>} [overrides]
 */
function build(checks, overrides = {}) {
  return buildSystemCheckItems({
    systemChecks: { checks },
    ...NO_EXCLUSIONS,
    ...overrides,
  });
}

const ids = (items) => items.map((item) => item.id);

// Only these can ever be `failed`: lunad reports everything else as a warning
// at worst. A fixture that fails a check lunad can't fail proves nothing.
const CLOCK_FAILED = { status: "failed", message: "The clock is wrong: it says 2020-01-01." };
const DRIVE_RW_FAILED = {
  status: "failed",
  message: "Luna can't save new files to Photos.",
  details: { drive_label: "Photos" },
};

describe("buildSystemCheckItems", () => {
  it("returns nothing when there are no system checks", () => {
    expect(buildSystemCheckItems({ systemChecks: null, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: undefined, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: {}, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: { checks: undefined }, ...NO_EXCLUSIONS })).toEqual([]);
    expect(build({})).toEqual([]);
  });

  it("skips an entry that is empty instead of throwing", () => {
    const items = build({ network: null, clock: CLOCK_FAILED });
    expect(ids(items)).toEqual(["check:clock"]);
  });

  it("makes a row only for failed checks; warnings and passes stay out", () => {
    const items = build({
      clock: { status: "warning", message: "The clock may be off." },
      database: { status: "passed" },
      drive_d1_read_write: DRIVE_RW_FAILED,
    });
    expect(ids(items)).toEqual(["check:drive_d1_read_write"]);
  });

  it("makes no row for a failure nobody can act on", () => {
    for (const name of NO_ACTION_CHECKS) {
      expect(build({ [name]: { status: "failed", message: "Something is wrong." } })).toEqual([]);
    }
  });

  it("leaves out backup checks, which backup rows already cover", () => {
    const items = build({
      cloud_backup_c1: { status: "failed", category: "backups", details: { folder: "Photos" } },
      protect_3f6a: { status: "failed", category: "backups" },
    });
    expect(items).toEqual([]);
  });

  it("leaves out hard drive wear checks, which the drive health row covers", () => {
    const items = build({
      drive_d1_smart: { status: "failed", message: "Drive is wearing out.", details: { drive_label: "Photos" } },
    });
    expect(items).toEqual([]);
  });

  it("leaves out a save test when that drive already has a drive row", () => {
    const items = build(
      { drive_d1_read_write: DRIVE_RW_FAILED },
      { coveredDriveLabels: ["Photos"] },
    );
    expect(items).toEqual([]);
  });

  it("keeps a save test for a drive with no drive row, opening Files", () => {
    const items = build(
      { drive_d2_read_write: { ...DRIVE_RW_FAILED, details: { drive_label: "Documents" } } },
      { coveredDriveLabels: ["Photos"] },
    );
    expect(items).toEqual([
      {
        id: "check:drive_d2_read_write",
        rank: 20,
        tone: "problem",
        title: ["Documents — save test"],
        detail: "Luna can't save new files to Photos.",
        action: { label: "Open Files", href: "/files" },
      },
    ]);
  });

  it("keeps a save test without a drive label under the generic title", () => {
    const items = build(
      { drive_d3_read_write: { status: "failed" } },
      { coveredDriveLabels: ["Photos"] },
    );
    expect(items).toEqual([
      {
        id: "check:drive_d3_read_write",
        rank: 20,
        tone: "problem",
        title: ["Drive save test"],
        action: { label: "Open Files", href: "/files" },
      },
    ]);
  });

  it("titles a kept save test with its drive label", () => {
    const [item] = build({ drive_d2_read_write: DRIVE_RW_FAILED });
    expect(item.title).toEqual(["Photos — save test"]);
  });

  it("leaves out the clock check when the no-route row already says it", () => {
    const items = build({ clock: CLOCK_FAILED }, { noRouteShown: true });
    expect(items).toEqual([]);
  });

  it("keeps the clock check when the no-route row is not shown", () => {
    const items = build({ clock: CLOCK_FAILED });
    expect(items).toEqual([
      {
        id: "check:clock",
        rank: 20,
        tone: "problem",
        title: ["Clock"],
        detail: "The clock is wrong: it says 2020-01-01.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });

  it("uses the check message as detail", () => {
    const [item] = build({ clock: { status: "failed", message: "Clock is wrong." } });
    expect(item.detail).toBe("Clock is wrong.");
  });

  it("has no detail key when a failed check has no message", () => {
    const [missing] = build({ clock: { status: "failed" } });
    expect(missing).not.toHaveProperty("detail");

    const [empty] = build({ clock: { status: "failed", message: "" } });
    expect(empty).not.toHaveProperty("detail");

    const [blank] = build({ clock: { status: "failed", message: "   " } });
    expect(blank).not.toHaveProperty("detail");
  });

  it("sorts rows by id so the output is deterministic", () => {
    const items = build({
      drive_d2_read_write: DRIVE_RW_FAILED,
      clock: { status: "failed" },
      drive_d1_read_write: DRIVE_RW_FAILED,
    });
    expect(ids(items)).toEqual([
      "check:clock",
      "check:drive_d1_read_write",
      "check:drive_d2_read_write",
    ]);
  });

  it("turns two failed checks into two problem rows with the default action", () => {
    const items = build({
      clock: { status: "failed", category: "system", message: "Clock is wrong." },
      drive_d1_read_write: DRIVE_RW_FAILED,
      database: { status: "passed", category: "system" },
    });
    expect(items).toEqual([
      {
        id: "check:clock",
        rank: 20,
        tone: "problem",
        title: ["Clock"],
        detail: "Clock is wrong.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
      {
        id: "check:drive_d1_read_write",
        rank: 20,
        tone: "problem",
        title: ["Photos — save test"],
        detail: "Luna can't save new files to Photos.",
        action: { label: "Open Files", href: "/files" },
      },
    ]);
  });
});

describe("pillChecks", () => {
  it("lists the warnings, with their plain label and message", () => {
    const found = pillChecks({
      checks: {
        video_tools: { status: "warning", message: "Videos get no previews.", category: "features" },
        database: { status: "passed", message: "OK" },
      },
    });
    expect(found.map((check) => check.name)).toEqual(["video_tools"]);
    expect(found[0].message).toBe("Videos get no previews.");
    expect(found[0].status).toBe("warning");
    expect(typeof found[0].label).toBe("string");
    expect(found[0].label).not.toBe("");
  });

  it("carries a failed check that has no Needs you row", () => {
    const found = pillChecks({
      checks: {
        disk_space: { status: "failed", message: "Luna's own storage is almost full." },
        database: { status: "failed", message: "Signing in may not work." },
      },
    });
    expect(found.map((check) => check.name)).toEqual(["disk_space", "database"]);
    expect(found.map((check) => check.status)).toEqual(["failed", "failed"]);
  });

  it("leaves a failed check with a real fix to its Needs you row", () => {
    const found = pillChecks({
      checks: {
        clock: { status: "failed", message: "The clock is wrong." },
        drive_d1_read_write: DRIVE_RW_FAILED,
      },
    });
    expect(found).toEqual([]);
  });

  it("returns nothing when there are no checks, or an entry is empty", () => {
    expect(pillChecks(null)).toEqual([]);
    expect(pillChecks(undefined)).toEqual([]);
    expect(pillChecks({})).toEqual([]);
    expect(pillChecks({ checks: { clock_sync: null } })).toEqual([]);
  });
});
