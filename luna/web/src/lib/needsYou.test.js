import { describe, expect, it, vi } from "vitest";
import { buildNeedsYouItems } from "./needsYou.js";
import { describeDriveHealth } from "./driveHealth.js";
import { formatBytes } from "./formatBytes.js";

const MEMBER = { isAdmin: false, userId: "sam" };

/** Deep-freezes a value, so any write to the input throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * An Admin input with nothing to show. One healthy drive is listed so the
 * first-run "No drives yet" row does not appear unless a test asks for it.
 */
/** @returns {any} */
function emptyInput(overrides = {}) {
  return {
    isAdmin: true,
    userId: "admin",
    drives: [{ id: "spare", label: "Spare", state: "as_is" }],
    drivesLoading: false,
    driveSummaries: {},
    driveHealth: {},
    systemChecks: null,
    backupRows: [],
    phrase: null,
    connect: null,
    network: null,
    detected: [],
    ...overrides,
  };
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
function drive(overrides = {}) {
  return { id: "d1", label: "Photos", state: "as_is", ...overrides };
}

/**
 * A drive backup row that needs a look.
 * @returns {any}
 */
function failingDriveRow(overrides = {}) {
  return {
    id: "b1",
    kind: "drive",
    private: false,
    source_drive: "s1",
    source_path: "Photos",
    source_name: "Photos",
    destination: "Backup drive",
    target_drive: "t1",
    target_drive_name: "Backup drive",
    state: "failing",
    status: "active",
    last_ok_at: 0,
    last_error: "The backup drive is full.",
    hard: false,
    created_by: "admin",
    ...overrides,
  };
}

/**
 * A healthy cloud backup, so it does not add a backup row but does show the phrase row.
 * @returns {any}
 */
function healthyCloudRow(overrides = {}) {
  return {
    id: "c1",
    kind: "cloud",
    private: false,
    source_drive: "s1",
    source_path: "Documents",
    source_name: "Documents",
    destination: "Cloud",
    state: "ok",
    status: "active",
    last_ok_at: 0,
    last_checked_at: 0,
    check_problem: null,
    source_missing: false,
    created_by: "admin",
    ...overrides,
  };
}

const healthyCheck = { status: "passed" };

/**
 * Every Admin trigger at once, each on its own drive or check, so no two rows collide.
 * @returns {any}
 */
function fullAdminInput(overrides = {}) {
  return emptyInput({
    drives: [
      drive({ id: "failed-drive", label: "Old USB", state: "failed" }),
      drive({ id: "worn-drive", label: "Photos drive", state: "as_is" }),
      drive({ id: "full-drive", label: "Backup drive", state: "as_is" }),
    ],
    driveHealth: {
      "worn-drive": { available: true, overall: "passed", temperature_c: 35, reallocated_sectors: 4 },
    },
    driveSummaries: {
      "full-drive": { mounted: true, total_bytes: 100e9, free_bytes: 5e9 },
    },
    systemChecks: {
      checks: { disk_space: { status: "failed", category: "storage", message: "Storage is nearly full." } },
    },
    backupRows: [failingDriveRow(), healthyCloudRow()],
    phrase: { check_due: true },
    connect: { device_token_error: "Your device token was revoked." },
    network: { has_default_route: false },
    detected: [{ id: "usb-1" }],
    ...overrides,
  });
}

const ids = (items) => items.map((item) => item.id);

describe("drive rows (Admin)", () => {
  it("gives a failed drive an exact Open Drives row", () => {
    const items = buildNeedsYouItems(emptyInput({ drives: [drive({ state: "failed" })] }));
    expect(items).toStrictEqual([
      {
        id: "drive-failed:d1",
        rank: 10,
        tone: "problem",
        title: [{ name: "Photos" }, " ran into a problem"],
        detail: "Open Drives to see what Luna found.",
        action: { label: "Open Drives", href: "/drives" },
      },
    ]);
  });

  it("gives a drive with a worn spot a warning row with the health detail", () => {
    const health = { available: true, overall: "passed", temperature_c: 40, reallocated_sectors: 12 };
    const items = buildNeedsYouItems(
      emptyInput({ drives: [drive()], driveHealth: { d1: health } }),
    );
    expect(items).toStrictEqual([
      {
        id: "drive-health:d1",
        rank: 30,
        tone: "problem",
        title: [{ name: "Photos" }, " is working, with a warning"],
        detail: describeDriveHealth(health).detail,
        action: { label: "Open Drives", href: "/drives" },
      },
    ]);
  });

  it("gives a drive that reports a failure a needs attention row", () => {
    const health = { available: true, overall: "failed", temperature_c: null, reallocated_sectors: 0 };
    const items = buildNeedsYouItems(
      emptyInput({ drives: [drive()], driveHealth: { d1: health } }),
    );
    expect(items).toStrictEqual([
      {
        id: "drive-health:d1",
        rank: 30,
        tone: "problem",
        title: [{ name: "Photos" }, " needs attention"],
        detail: describeDriveHealth(health).detail,
        action: { label: "Open Drives", href: "/drives" },
      },
    ]);
  });

  it("shows nothing for a healthy drive, a missing report, or an unavailable report", () => {
    const healthy = { available: true, overall: "passed", temperature_c: 31, reallocated_sectors: 0 };
    const unavailable = { available: false, overall: "unknown" };
    for (const health of [healthy, null, undefined, unavailable]) {
      const items = buildNeedsYouItems(emptyInput({ drives: [drive()], driveHealth: { d1: health } }));
      expect(items).toEqual([]);
    }
  });

  it("ignores health data for a drive that is not in the drive list", () => {
    const worn = { available: true, overall: "failed", reallocated_sectors: 0 };
    expect(buildNeedsYouItems(emptyInput({ drives: [], driveHealth: { ghost: worn } }))).toEqual([
      expect.objectContaining({ id: "no-drives" }),
    ]);
  });

  it("gives a failed drive only the drive-failed row when it has no health data", () => {
    const items = buildNeedsYouItems(emptyInput({ drives: [drive({ state: "failed" })] }));
    expect(ids(items)).toEqual(["drive-failed:d1"]);
  });

  it("gives a read-only drive that is almost full a Browse files row", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive({ state: "readonly" })],
        driveSummaries: { d1: { mounted: true, total_bytes: 100e9, free_bytes: 4e9 } },
      }),
    );
    expect(ids(items)).toEqual(["drive-full:d1"]);
  });

  it("gives an almost full drive an exact Browse files row with decimal sizes", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive()],
        driveSummaries: { d1: { mounted: true, total_bytes: 64e9, free_bytes: 4e9 } },
      }),
    );
    expect(items).toStrictEqual([
      {
        id: "drive-full:d1",
        rank: 80,
        tone: "problem",
        title: [{ name: "Photos" }, " is almost full"],
        detail: `${formatBytes(4e9)} free of ${formatBytes(64e9)}`,
        action: { label: "Browse files", href: "/drives/d1" },
      },
    ]);
  });

  it("flags a drive at 9% free but not one at exactly 10% free", () => {
    const at = (free) =>
      buildNeedsYouItems(
        emptyInput({
          drives: [drive()],
          driveSummaries: { d1: { mounted: true, total_bytes: 100e9, free_bytes: free } },
        }),
      );
    expect(ids(at(10e9))).toEqual([]);
    expect(ids(at(9e9))).toEqual(["drive-full:d1"]);
    expect(at(9e9)[0].detail).toBe(`${formatBytes(9e9)} free of ${formatBytes(100e9)}`);
  });

  it("does not flag a drive with unknown free space, zero total, unmounted, or missing state", () => {
    const cases = [
      { state: "as_is", summary: { mounted: true, total_bytes: 100e9, free_bytes: null } },
      { state: "as_is", summary: { mounted: true, total_bytes: 0, free_bytes: 0 } },
      { state: "as_is", summary: { mounted: false, total_bytes: 100e9, free_bytes: 1e9 } },
      { state: "missing", summary: { mounted: true, total_bytes: 100e9, free_bytes: 1e9 } },
      { state: "as_is", summary: undefined },
      { state: "failed", summary: { mounted: true, total_bytes: 100e9, free_bytes: 1e9 } },
    ];
    for (const { state, summary } of cases) {
      const items = buildNeedsYouItems(
        emptyInput({ drives: [drive({ state })], driveSummaries: { d1: summary } }),
      );
      expect(ids(items).filter((id) => id.startsWith("drive-full:"))).toEqual([]);
    }
  });
});

describe("system check rows (Admin)", () => {
  it("gives a failed check an exact row with the message and Open system checks", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        systemChecks: {
          checks: { disk_space: { status: "failed", category: "storage", message: "Storage is nearly full." } },
        },
      }),
    );
    expect(items).toStrictEqual([
      {
        id: "check:disk_space",
        rank: 20,
        tone: "problem",
        title: ["Storage space"],
        detail: "Storage is nearly full.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });

  it("shows no system row for a warning or a passed check", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        systemChecks: {
          checks: {
            clock: { status: "warning", message: "Clock is slow." },
            database: healthyCheck,
          },
        },
      }),
    );
    expect(items).toEqual([]);
  });

  it("drops a failed save test whose drive already has a drive-failed row", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive({ id: "d1", label: "Photos", state: "failed" })],
        systemChecks: {
          checks: {
            drive_d1_read_write: {
              status: "failed",
              category: "drives",
              message: "Could not save a test file.",
              details: { drive_label: "Photos" },
            },
          },
        },
      }),
    );
    expect(ids(items)).toEqual(["drive-failed:d1"]);
  });

  it("drops a failed save test whose drive already has a drive-health row", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive({ id: "d1", label: "Photos", state: "as_is" })],
        driveHealth: {
          d1: { available: true, overall: "passed", reallocated_sectors: 3 },
        },
        systemChecks: {
          checks: {
            drive_d1_read_write: {
              status: "failed",
              category: "drives",
              message: "Could not save a test file.",
              details: { drive_label: "Photos" },
            },
          },
        },
      }),
    );
    expect(ids(items)).toEqual(["drive-health:d1"]);
  });

  it("keeps a failed save test for a drive whose health is fine, with Open Drives", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive({ id: "d1", label: "Photos", state: "as_is" })],
        driveHealth: { d1: { available: true, overall: "passed", reallocated_sectors: 0 } },
        systemChecks: {
          checks: {
            drive_d1_read_write: {
              status: "failed",
              category: "drives",
              message: "Could not save a test file.",
              details: { drive_label: "Photos" },
            },
          },
        },
      }),
    );
    expect(items).toStrictEqual([
      {
        id: "check:drive_d1_read_write",
        rank: 20,
        tone: "problem",
        title: ["Photos — save test"],
        detail: "Could not save a test file.",
        action: { label: "Open Drives", href: "/drives" },
      },
    ]);
  });

  it("keeps a failed save test for a drive that is not in the drive list", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [],
        systemChecks: {
          checks: {
            drive_d9_read_write: {
              status: "failed",
              category: "drives",
              details: { drive_label: "Spare" },
            },
          },
        },
      }),
    );
    expect(ids(items)).toEqual(["check:drive_d9_read_write", "no-drives"]);
  });

  it("drops a failed hard drive wear check, which the drive health row covers", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [drive()],
        systemChecks: {
          checks: { drive_d1_smart: { status: "failed", category: "drives", details: { drive_label: "Photos" } } },
        },
      }),
    );
    expect(ids(items)).toEqual([]);
  });

  it("drops a failed network check when the no-route row is shown", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        network: { has_default_route: false },
        systemChecks: { checks: { network: { status: "failed", message: "No route." } } },
      }),
    );
    expect(ids(items)).toEqual(["no-route"]);
  });

  it("keeps a failed network check when the route is up", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        network: { has_default_route: true },
        systemChecks: { checks: { network: { status: "failed", message: "Network is slow." } } },
      }),
    );
    expect(items).toStrictEqual([
      {
        id: "check:network",
        rank: 20,
        tone: "problem",
        title: ["Network"],
        detail: "Network is slow.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });

  it("keeps a failed network check when the route state is unknown", () => {
    for (const network of [null, {}, { has_default_route: undefined }]) {
      const items = buildNeedsYouItems(
        emptyInput({
          network,
          systemChecks: { checks: { network: { status: "failed", message: "No route." } } },
        }),
      );
      expect(ids(items)).toEqual(["check:network"]);
    }
  });

  it("drops failed connect and remote access checks when the device token row is shown", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        connect: { device_token_error: "Token was revoked." },
        systemChecks: {
          checks: {
            connect: { status: "failed", message: "Connect is offline." },
            remote_access: { status: "failed", message: "Remote access is off." },
          },
        },
      }),
    );
    expect(ids(items)).toEqual(["device-token"]);
  });

  it("keeps a failed connect check when there is no device token row", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        connect: { device_token_error: "   " },
        systemChecks: { checks: { connect: { status: "failed", message: "Connect is offline." } } },
      }),
    );
    expect(ids(items)).toEqual(["check:connect"]);
  });

  it("leaves backup-category checks to the backup rows", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        systemChecks: {
          checks: {
            cloud_backup_c1: { status: "failed", category: "backups", details: { folder: "Photos" } },
          },
        },
      }),
    );
    expect(items).toEqual([]);
  });
});

describe("device token, no route, new drive, and no drives (Admin)", () => {
  it("gives a device token error an exact row with the error as detail", () => {
    const items = buildNeedsYouItems(
      emptyInput({ connect: { device_token_error: "Your device token was revoked." } }),
    );
    expect(items).toStrictEqual([
      {
        id: "device-token",
        rank: 50,
        tone: "problem",
        title: ["Luna Connect needs a new device token"],
        detail: "Your device token was revoked.",
        action: { label: "Change the device token", href: "/settings#about" },
      },
    ]);
  });

  it("shows no token row for a blank, non-text, or missing error", () => {
    const malformed = /** @type {any[]} */ ([null, {}, { device_token_error: "" }, { device_token_error: "   " }, { device_token_error: 42 }]);
    for (const connect of malformed) {
      expect(buildNeedsYouItems(emptyInput({ connect }))).toEqual([]);
    }
  });

  it("gives the no-route row only when the route is strictly down", () => {
    const items = buildNeedsYouItems(emptyInput({ network: { has_default_route: false } }));
    expect(items).toStrictEqual([
      {
        id: "no-route",
        rank: 60,
        tone: "problem",
        title: ["Luna can't reach the internet"],
        detail: "Check that your router or modem is online.",
        action: { label: "Open system checks", href: "/settings#about" },
      },
    ]);
  });

  it("shows no no-route row when the route state is undefined or null", () => {
    expect(buildNeedsYouItems(emptyInput({ network: { has_default_route: undefined } }))).toEqual([]);
    expect(buildNeedsYouItems(emptyInput({ network: { has_default_route: null } }))).toEqual([]);
    expect(buildNeedsYouItems(emptyInput({ network: null }))).toEqual([]);
    expect(buildNeedsYouItems(emptyInput({ network: { has_default_route: true } }))).toEqual([]);
  });

  it("gives the new drive row an Add drive intent when a drive is detected", () => {
    const items = buildNeedsYouItems(emptyInput({ detected: [{ id: "usb-1" }] }));
    expect(items).toStrictEqual([
      {
        id: "new-drive",
        rank: 70,
        tone: "info",
        title: ["New drive plugged in"],
        detail: "Nothing on it changes until you confirm.",
        action: { label: "Add drive", intent: "open-drive-picker" },
      },
    ]);
  });

  it("shows no new drive row when nothing is detected", () => {
    expect(buildNeedsYouItems(emptyInput({ detected: [] }))).toEqual([]);
  });

  it("gives the no-drives row no action when there are no drives and loading is done", () => {
    const [item] = buildNeedsYouItems(emptyInput({ drives: [], drivesLoading: false }));
    expect(item).toStrictEqual({
      id: "no-drives",
      rank: 100,
      tone: "info",
      title: ["No drives yet"],
      detail: "Plug a USB drive into Luna to get started.",
    });
    expect(item).not.toHaveProperty("action");
  });

  it("shows no no-drives row while drives are still loading", () => {
    expect(buildNeedsYouItems(emptyInput({ drives: [], drivesLoading: true }))).toEqual([]);
  });

  it("shows no no-drives row when there is at least one drive", () => {
    expect(buildNeedsYouItems(emptyInput({ drives: [drive({ state: "ejected" })] }))).toEqual([]);
  });
});

describe("ordering", () => {
  it("sorts every Admin row by rank from 10 to 90", () => {
    const items = buildNeedsYouItems(fullAdminInput());
    expect(items.map((item) => item.rank)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(ids(items)).toEqual([
      "drive-failed:failed-drive",
      "check:disk_space",
      "drive-health:worn-drive",
      "backup:drive:b1",
      "device-token",
      "no-route",
      "new-drive",
      "drive-full:full-drive",
      "phrase-check",
    ]);
  });

  it("puts the no-drives row last", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [],
        systemChecks: { checks: { disk_space: { status: "failed", category: "storage", message: "Full." } } },
        backupRows: [failingDriveRow(), healthyCloudRow()],
        phrase: { check_due: true },
        connect: { device_token_error: "Revoked." },
        network: { has_default_route: false },
        detected: [{ id: "usb-1" }],
      }),
    );
    expect(ids(items)).toEqual([
      "check:disk_space",
      "backup:drive:b1",
      "device-token",
      "no-route",
      "new-drive",
      "phrase-check",
      "no-drives",
    ]);
    expect(items.at(-1).rank).toBe(100);
  });

  it("orders two rows of the same rank by id", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        drives: [
          drive({ id: "b-drive", label: "B", state: "failed" }),
          drive({ id: "a-drive", label: "A", state: "failed" }),
        ],
      }),
    );
    expect(ids(items)).toEqual(["drive-failed:a-drive", "drive-failed:b-drive"]);
  });
});

describe("Member view", () => {
  it("shows a Member only their own failing backup, never Admin rows", () => {
    const items = buildNeedsYouItems({
      ...fullAdminInput({
        backupRows: [
          failingDriveRow({ id: "own", created_by: "sam", last_error: "Drive unplugged." }),
          failingDriveRow({ id: "theirs", created_by: "admin" }),
          healthyCloudRow({ id: "own-cloud", created_by: "sam" }),
        ],
        phrase: null,
      }),
      ...MEMBER,
    });
    expect(ids(items)).toEqual(["backup:drive:own"]);
  });

  it("adds the phrase row to a Member's own backups when the check is due", () => {
    const items = buildNeedsYouItems({
      ...fullAdminInput({
        backupRows: [
          failingDriveRow({ id: "own", created_by: "sam" }),
          failingDriveRow({ id: "theirs", created_by: "admin" }),
          healthyCloudRow({ id: "own-cloud", created_by: "sam" }),
        ],
        phrase: { check_due: true },
      }),
      ...MEMBER,
    });
    expect(ids(items)).toEqual(["backup:drive:own", "phrase-check"]);
    expect(items[1]).toStrictEqual({
      id: "phrase-check",
      rank: 90,
      tone: "info",
      title: ["Check your recovery phrase"],
      detail: "It's been a while. Make sure your 12 words still open your cloud backups.",
      action: { label: "Check now", intent: "check-phrase" },
    });
  });

  it("keeps every Admin trigger off a Member, even with an empty drive list", () => {
    const items = buildNeedsYouItems({
      ...fullAdminInput({
        drives: [],
        drivesLoading: false,
        backupRows: [
          failingDriveRow({ id: "own", created_by: "sam" }),
          failingDriveRow({ id: "theirs", created_by: "admin" }),
          healthyCloudRow({ id: "own-cloud", created_by: "sam" }),
        ],
        phrase: { check_due: true },
      }),
      ...MEMBER,
    });
    expect(ids(items)).toEqual(["backup:drive:own", "phrase-check"]);
  });

  it("gives a Member no drive, system, network, token, new drive or storage row", () => {
    const items = buildNeedsYouItems({ ...fullAdminInput({ backupRows: [] }), ...MEMBER });
    expect(items).toEqual([]);
  });

  it("gives a Member no no-drives row with an empty drive list", () => {
    expect(buildNeedsYouItems(emptyInput({ isAdmin: false, userId: "sam", drives: [] }))).toEqual([]);
  });

  it("does not show a Member's phrase row when only another person's cloud backup exists", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        isAdmin: false,
        userId: "sam",
        phrase: { check_due: true },
        backupRows: [healthyCloudRow({ created_by: "admin" })],
      }),
    );
    expect(items).toEqual([]);
  });
});

describe("backups and the phrase row (Admin and Member)", () => {
  it("shows an Admin another person's failing backup that is not private", () => {
    const items = buildNeedsYouItems(
      emptyInput({ backupRows: [failingDriveRow({ id: "b9", created_by: "sam" })] }),
    );
    expect(ids(items)).toEqual(["backup:drive:b9"]);
  });

  it("hides another person's private failing backup from an Admin", () => {
    const items = buildNeedsYouItems(
      emptyInput({ backupRows: [failingDriveRow({ id: "p1", private: true, created_by: "sam" })] }),
    );
    expect(items).toEqual([]);
  });

  it("shows an Admin their own private failing backup", () => {
    const items = buildNeedsYouItems(
      emptyInput({ backupRows: [failingDriveRow({ id: "p2", private: true, created_by: "admin" })] }),
    );
    expect(ids(items)).toEqual(["backup:drive:p2"]);
  });

  it("hides another person's private failing backup from a Member", () => {
    const items = buildNeedsYouItems(
      emptyInput({
        isAdmin: false,
        userId: "sam",
        backupRows: [failingDriveRow({ id: "p3", private: true, created_by: "admin" })],
      }),
    );
    expect(items).toEqual([]);
  });

  it("shows the phrase row only when the check is due and a visible cloud backup exists", () => {
    const withCloud = emptyInput({ phrase: { check_due: true }, backupRows: [healthyCloudRow()] });
    expect(ids(buildNeedsYouItems(withCloud))).toEqual(["phrase-check"]);

    const notDue = emptyInput({ phrase: { check_due: false }, backupRows: [healthyCloudRow()] });
    expect(buildNeedsYouItems(notDue)).toEqual([]);

    const noCloud = emptyInput({ phrase: { check_due: true }, backupRows: [failingDriveRow()] });
    expect(ids(buildNeedsYouItems(noCloud))).toEqual(["backup:drive:b1"]);

    const onlyHiddenCloud = emptyInput({
      phrase: { check_due: true },
      backupRows: [healthyCloudRow({ private: true, created_by: "sam" })],
    });
    expect(buildNeedsYouItems(onlyHiddenCloud)).toEqual([]);
  });

  it("shows no phrase row when the phrase is null", () => {
    expect(buildNeedsYouItems(emptyInput({ phrase: null, backupRows: [healthyCloudRow()] }))).toEqual([]);
  });
});

describe("empty and null input", () => {
  it("returns nothing for a Member with null or empty input", () => {
    const nulls = {
      isAdmin: false,
      userId: "sam",
      drives: [],
      drivesLoading: false,
      driveSummaries: null,
      driveHealth: null,
      systemChecks: null,
      backupRows: null,
      phrase: null,
      connect: null,
      network: null,
      detected: null,
    };
    expect(buildNeedsYouItems(nulls)).toEqual([]);
    expect(buildNeedsYouItems({ ...nulls, backupRows: [], driveSummaries: {}, driveHealth: {}, detected: [] })).toEqual([]);
  });

  it("returns nothing for an Admin with null input while drives are loading", () => {
    const nulls = {
      isAdmin: true,
      userId: "admin",
      drives: [],
      drivesLoading: true,
      driveSummaries: null,
      driveHealth: null,
      systemChecks: null,
      backupRows: null,
      phrase: null,
      connect: null,
      network: null,
      detected: null,
    };
    expect(buildNeedsYouItems(nulls)).toEqual([]);
    expect(buildNeedsYouItems({ ...nulls, systemChecks: { checks: {} }, driveHealth: {}, driveSummaries: {} })).toEqual([]);
  });

  it("tolerates a missing drive list and a missing user id", () => {
    expect(buildNeedsYouItems(/** @type {any} */ ({ isAdmin: false, backupRows: [] }))).toEqual([]);
    expect(buildNeedsYouItems(/** @type {any} */ ({ isAdmin: true, drivesLoading: true }))).toEqual([]);
  });
});

describe("purity", () => {
  it("does not change its input, even when every branch runs", () => {
    const input = deepFreeze(fullAdminInput());
    expect(() => buildNeedsYouItems(input)).not.toThrow();
    expect(ids(buildNeedsYouItems(input))).toHaveLength(9);
  });

  it("does not change a Member's input either", () => {
    const input = deepFreeze({
      ...fullAdminInput({
        backupRows: [
          failingDriveRow({ id: "own", created_by: "sam" }),
          healthyCloudRow({ id: "own-cloud", created_by: "sam" }),
        ],
        phrase: { check_due: true },
      }),
      ...MEMBER,
    });
    expect(() => buildNeedsYouItems(input)).not.toThrow();
    expect(ids(buildNeedsYouItems(input))).toEqual(["backup:drive:own", "phrase-check"]);
  });

  it("reads no clock", () => {
    const now = vi.spyOn(Date, "now");
    try {
      buildNeedsYouItems(fullAdminInput());
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("gives the same rows for the same input", () => {
    expect(buildNeedsYouItems(fullAdminInput())).toStrictEqual(buildNeedsYouItems(fullAdminInput()));
  });
});
