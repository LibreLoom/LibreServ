import { describe, expect, it } from "vitest";
import { buildSystemCheckItems, warningChecks } from "./needsYouChecks.js";

const NO_EXCLUSIONS = { coveredDriveLabels: [], noRouteShown: false, tokenShown: false };

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

describe("buildSystemCheckItems", () => {
  it("returns nothing when there are no system checks", () => {
    expect(buildSystemCheckItems({ systemChecks: null, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: undefined, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: {}, ...NO_EXCLUSIONS })).toEqual([]);
    expect(buildSystemCheckItems({ systemChecks: { checks: undefined }, ...NO_EXCLUSIONS })).toEqual([]);
    expect(build({})).toEqual([]);
  });

  it("skips an entry that is empty instead of throwing", () => {
    const items = build({
      clock: null,
      disk_space: { status: "failed", message: "Storage is nearly full." },
    });
    expect(ids(items)).toEqual(["check:disk_space"]);
  });

  it("makes a row only for failed checks; warnings and passes stay out", () => {
    const items = build({
      clock: { status: "warning", message: "Clock is slow." },
      database: { status: "passed" },
      disk_space: { status: "failed", message: "Storage is full." },
    });
    expect(ids(items)).toEqual(["check:disk_space"]);
  });

  it("leaves out backup checks, which backup rows already cover", () => {
    const items = build({
      cloud_backup_c1: { status: "failed", category: "backups", details: { folder: "Photos" } },
      protect_3f6a: { status: "failed", category: "backups" },
    });
    expect(items).toEqual([]);
  });

  it("keeps a failed check from any other category", () => {
    const items = build({ disk_space: { status: "failed", category: "storage" } });
    expect(ids(items)).toEqual(["check:disk_space"]);
  });

  it("leaves out hard drive wear checks, which the drive health row covers", () => {
    const items = build({
      drive_d1_smart: { status: "failed", message: "Drive is wearing out.", details: { drive_label: "Photos" } },
    });
    expect(items).toEqual([]);
  });

  it("keeps the system hard drive report check, which is not a per-drive wear check", () => {
    const items = build({ smart_tool: { status: "failed", message: "Report tool is missing." } });
    expect(ids(items)).toEqual(["check:smart_tool"]);
  });

  it("leaves out the network check when the no-route row is shown", () => {
    const items = build({ network: { status: "failed", message: "No route." } }, { noRouteShown: true });
    expect(items).toEqual([]);
  });

  it("keeps the network check with Open system checks when no-route row is not shown", () => {
    const items = build({ network: { status: "failed", message: "No route." } });
    expect(items).toEqual([
      {
        id: "check:network",
        rank: 20,
        tone: "problem",
        title: ["Network"],
        detail: "No route.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });

  it("leaves out connect and remote access checks when the device token row is shown", () => {
    const items = build(
      {
        connect: { status: "failed", message: "Token expired." },
        remote_access: { status: "failed", message: "Remote access is off." },
      },
      { tokenShown: true },
    );
    expect(items).toEqual([]);
  });

  it("keeps connect and remote access checks when the device token row is not shown", () => {
    const items = build({
      connect: { status: "failed", message: "Token expired." },
      remote_access: { status: "failed", message: "Remote access is off." },
    });
    expect(ids(items)).toEqual(["check:connect", "check:remote_access"]);
    expect(items.map((item) => item.title)).toEqual([["Luna Connect"], ["Remote access"]]);
  });

  it("leaves out a save test when that drive already has a drive row", () => {
    const items = build(
      {
        drive_d1_read_write: {
          status: "failed",
          message: "Could not save a test file.",
          details: { drive_label: "Photos" },
        },
      },
      { coveredDriveLabels: ["Photos"] },
    );
    expect(items).toEqual([]);
  });

  it("keeps a save test for a drive with no drive row, opening Files", () => {
    const items = build(
      {
        drive_d2_read_write: {
          status: "failed",
          message: "Could not save a test file.",
          details: { drive_label: "Documents" },
        },
      },
      { coveredDriveLabels: ["Photos"] },
    );
    expect(items).toEqual([
      {
        id: "check:drive_d2_read_write",
        rank: 20,
        tone: "problem",
        title: ["Documents — save test"],
        detail: "Could not save a test file.",
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
    const [item] = build({
      drive_d2_read_write: { status: "failed", details: { drive_label: "Photos" } },
    });
    expect(item.title).toEqual(["Photos — save test"]);
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
      disk_space: { status: "failed" },
      clock: { status: "failed" },
      database: { status: "failed" },
    });
    expect(ids(items)).toEqual(["check:clock", "check:database", "check:disk_space"]);
  });

  it("turns two failed checks into two problem rows with the default action", () => {
    const items = build({
      disk_space: { status: "failed", category: "storage", message: "Less than 1 GB free." },
      clock: { status: "failed", category: "system", message: "Clock is wrong." },
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
        id: "check:disk_space",
        rank: 20,
        tone: "problem",
        title: ["Storage space"],
        detail: "Less than 1 GB free.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });
});

describe("warningChecks", () => {
  it("lists only the checks that warn, with their plain label and message", () => {
    const found = warningChecks({
      checks: {
        clock_sync: { status: "warning", message: "Clock is a few minutes off.", category: "system" },
        database: { status: "passed", message: "OK" },
        disk_space: { status: "failed", message: "Low space" },
      },
    });
    expect(found.map((check) => check.name)).toEqual(["clock_sync"]);
    expect(found[0].message).toBe("Clock is a few minutes off.");
    expect(typeof found[0].label).toBe("string");
    expect(found[0].label).not.toBe("");
  });

  it("returns nothing when there are no checks, or an entry is empty", () => {
    expect(warningChecks(null)).toEqual([]);
    expect(warningChecks(undefined)).toEqual([]);
    expect(warningChecks({})).toEqual([]);
    expect(warningChecks({ checks: { clock_sync: null } })).toEqual([]);
  });
});
