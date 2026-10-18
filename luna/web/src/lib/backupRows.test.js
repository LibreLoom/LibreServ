import { describe, expect, it } from "vitest";
import {
  backupHeadline,
  backupStatus,
  buildBackupRows,
  groupByCreator,
  lastCopyLine,
  lastTestedLine,
  needsALook,
  privateGroups,
  sortByUrgency,
} from "./backupRows.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 86_400_000;

/** @returns {any} */
function drive(overrides = {}) {
  return {
    id: "d1",
    kind: "drive",
    source_drive: "s1",
    source_name: "Photos",
    source_path: "Photos",
    target_drive: "t1",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    last_ok_at: 0,
    hard: false,
    created_by: "u1",
    ...overrides,
  };
}

/** @returns {any} */
function cloud(overrides = {}) {
  return {
    id: "c1",
    kind: "cloud",
    source_drive: "s1",
    source_name: "Documents",
    source_path: "Documents",
    state: "ok",
    status: "active",
    last_ok_at: 0,
    created_by: "u1",
    private: false,
    last_checked_at: 0,
    check_problem: null,
    source_missing: false,
    ...overrides,
  };
}

describe("buildBackupRows", () => {
  it("keeps drive rows with the target drive as destination", () => {
    const [row] = buildBackupRows([drive()]);
    expect(row.kind).toBe("drive");
    expect(row.destination).toBe("Backup drive");
    expect(row.private).toBe(false);
  });

  it("gives cloud rows the destination Cloud", () => {
    const rows = buildBackupRows([], [cloud()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("cloud");
    expect(rows[0].destination).toBe("Cloud");
  });

  it("defaults both lists to empty", () => {
    expect(buildBackupRows()).toEqual([]);
    expect(buildBackupRows(undefined, undefined)).toEqual([]);
  });

  it("keeps private rows and sorts the most urgent first", () => {
    const rows = buildBackupRows(
      [drive({ id: "ok", last_ok_at: 100 }), drive({ id: "hard", hard: true, last_ok_at: 500 })],
      [cloud({ id: "priv", private: true, last_ok_at: 50 })],
    );
    expect(rows.map((r) => r.id)).toEqual(["hard", "priv", "ok"]);
    expect(rows.find((r) => r.id === "priv").private).toBe(true);
  });
});

describe("needsALook", () => {
  it("flags a failing or stale active drive backup", () => {
    expect(needsALook(drive({ state: "failing" }))).toBe(true);
    expect(needsALook(drive({ state: "stale" }))).toBe(true);
    expect(needsALook(drive())).toBe(false);
  });

  it("does not flag stopped or deleted-source backups", () => {
    expect(needsALook(drive({ state: "failing", status: "stopped" }))).toBe(false);
    expect(needsALook(drive({ state: "failing", status: "source_gone" }))).toBe(false);
  });

  it("flags a cloud row with a check problem", () => {
    expect(needsALook(cloud({ check_problem: "The copy could not be read." }))).toBe(true);
    expect(needsALook(cloud({ check_problem: "The copy could not be read.", status: "stopped" }))).toBe(false);
  });

  it("does not flag a drive row with a check problem", () => {
    expect(needsALook(drive({ check_problem: "Something." }))).toBe(false);
  });
});

describe("backupStatus", () => {
  it("shows Original is missing for a cloud row that held for a missing source", () => {
    expect(backupStatus(cloud({ source_missing: true }))).toEqual({
      label: "Original is missing",
      variant: "warning",
    });
  });

  it("labels drive rows in plain words", () => {
    expect(backupStatus(drive()).label).toBe("Up to date");
    expect(backupStatus(drive({ state: "failing" }))).toEqual({ label: "Last copy failed", variant: "error" });
    expect(backupStatus(drive({ status: "stopped" })).label).toBe("Stopped");
    expect(backupStatus(drive({ status: "source_gone" })).label).toBe("Original is gone");
  });
});

describe("sortByUrgency and lastCopyLine", () => {
  it("puts hard errors first, then the oldest good copy", () => {
    const sorted = sortByUrgency([
      { id: "y", last_ok_at: 200 },
      { id: "x", last_ok_at: 100 },
      { id: "z", last_ok_at: 300, hard: true },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["z", "x", "y"]);
  });

  it("says when there is no good copy yet", () => {
    expect(lastCopyLine(drive(), NOW)).toBe("No copy yet");
    expect(lastCopyLine(cloud({ last_ok_at: NOW / 1000 - 300 }), NOW)).toBe("Last copy 5 min ago");
  });
});

describe("groupByCreator and backupHeadline", () => {
  it("groups by creator and puts Someone last", () => {
    const users = [{ id: "u1", display_name: "Max" }];
    const groups = groupByCreator(
      [drive({ id: "a", created_by: "gone" }), drive({ id: "b", created_by: "u1" })],
      users,
    );
    expect(groups.map((g) => g.name)).toEqual(["Max", "Someone"]);
  });

  it("counts rows that need a look", () => {
    expect(backupHeadline([])).toBe("No backups yet");
    expect(backupHeadline([drive()])).toBe("All backed up");
    expect(backupHeadline([drive({ state: "stale" })])).toBe("1 backup needs a look");
    expect(backupHeadline([drive({ state: "stale" }), cloud({ check_problem: "x" })])).toBe(
      "2 backups need a look",
    );
  });
});

describe("lastTestedLine", () => {
  it("shows only the count when no cloud backup was ever checked", () => {
    expect(lastTestedLine([drive(), drive({ id: "d2" })], NOW)).toBe("2 backups");
    expect(lastTestedLine([cloud()], NOW)).toBe("1 backup");
  });

  it("uses the singular for one backup", () => {
    expect(lastTestedLine([drive()], NOW)).toBe("1 backup");
  });

  it("adds the newest cloud check when there is one", () => {
    const rows = [
      drive(),
      cloud({ last_checked_at: (NOW - 5 * DAY) / 1000 }),
      cloud({ id: "c2", last_checked_at: (NOW - 2 * DAY) / 1000 }),
    ];
    expect(lastTestedLine(rows, NOW)).toBe("3 backups · copies last tested 2 days ago");
  });

  it("reads Just now as just now", () => {
    const rows = Array.from({ length: 9 }, (_, i) => drive({ id: `d${i}` }));
    rows.push(cloud({ last_checked_at: NOW / 1000 - 10 }));
    expect(lastTestedLine(rows, NOW)).toBe("10 backups · copies last tested just now");
  });
});

describe("privateGroups", () => {
  it("names a deleted owner Deleted user", () => {
    const groups = privateGroups(
      { owners: [{ owner_id: "u9", name: "Sam", deleted: true, backups: 2, needs_look: true }] },
      [],
    );
    expect(groups).toEqual([
      { ownerId: "u9", name: "Deleted user", deleted: true, backups: 2, needsLook: 1 },
    ]);
  });

  it("uses the owner name for a live owner and handles no summary", () => {
    const groups = privateGroups({ owners: [{ owner_id: "u1", name: "Max", backups: 1, needs_look: false }] }, []);
    expect(groups[0]).toMatchObject({ name: "Max", deleted: false });
    expect(privateGroups(null, [])).toEqual([]);
  });
});
