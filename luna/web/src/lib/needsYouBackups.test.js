import { describe, expect, it } from "vitest";
import { buildBackupItems, buildPhraseItem, visibleBackupRows } from "./needsYouBackups.js";

const MISSING = "The folder or drive this backs up is not available right now.";
const FALLBACK = "The last copy did not finish. Open it to see what went wrong.";
const PHRASE_DETAIL = "It's been a while. Make sure your recovery words still open your cloud backups.";

/** @returns {any} */
function drive(overrides = {}) {
  return {
    id: "d1",
    kind: "drive",
    private: false,
    source_drive: "s1",
    source_name: "Photos",
    source_path: "Photos",
    destination: "Backup drive",
    target_drive: "t1",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    last_ok_at: 0,
    last_error: "",
    hard: false,
    created_by: "admin",
    ...overrides,
  };
}

/** @returns {any} */
function cloud(overrides = {}) {
  return drive({
    id: "c1",
    kind: "cloud",
    source_name: "Documents",
    source_path: "Documents",
    destination: "Cloud",
    target_drive: undefined,
    target_drive_name: undefined,
    last_checked_at: 0,
    check_problem: null,
    source_missing: false,
    ...overrides,
  });
}

const ADMIN = { isAdmin: true, userId: "admin" };
const MEMBER = { isAdmin: false, userId: "sam" };

describe("visibleBackupRows", () => {
  it("lets an Admin see other users' rows that are not private", () => {
    const rows = [drive({ id: "d1", created_by: "sam" }), cloud({ id: "c1", created_by: "sam" })];
    expect(visibleBackupRows(rows, ADMIN)).toEqual(rows);
  });

  it("hides a private row someone else created, even from an Admin", () => {
    const rows = [drive({ id: "d1", private: true, created_by: "sam" })];
    expect(visibleBackupRows(rows, ADMIN)).toEqual([]);
  });

  it("lets an Admin see their own private row", () => {
    const rows = [drive({ id: "d1", private: true, created_by: "admin" })];
    expect(visibleBackupRows(rows, ADMIN)).toEqual(rows);
  });

  it("shows a Member only the rows they created", () => {
    const mine = drive({ id: "d1", created_by: "sam" });
    const theirs = drive({ id: "d2", created_by: "admin" });
    expect(visibleBackupRows([mine, theirs], MEMBER)).toEqual([mine]);
  });

  it("never shows a Member a private row someone else created", () => {
    const rows = [drive({ id: "d1", private: true, created_by: "admin" })];
    expect(visibleBackupRows(rows, MEMBER)).toEqual([]);
  });

  it("shows a Member their own private row", () => {
    const rows = [drive({ id: "d1", private: true, created_by: "sam" })];
    expect(visibleBackupRows(rows, MEMBER)).toEqual(rows);
  });

  it("returns an empty list for empty or missing rows", () => {
    expect(visibleBackupRows([], ADMIN)).toEqual([]);
    expect(visibleBackupRows(undefined, ADMIN)).toEqual([]);
    expect(visibleBackupRows(null, MEMBER)).toEqual([]);
  });

  it("shows nothing when the viewer has no user id", () => {
    const rows = [drive({ created_by: undefined })];
    expect(visibleBackupRows(rows, {})).toEqual([]);
  });
});

describe("buildBackupItems", () => {
  it("gives an Admin one exact item for a failing drive backup", () => {
    const row = drive({ state: "failing", last_error: "The backup drive is full." });
    expect(buildBackupItems({ backupRows: [row], ...ADMIN })).toEqual([
      {
        id: "backup:drive:d1",
        rank: 40,
        tone: "problem",
        title: [{ name: "Photos" }, " backup didn't finish"],
        detail: "The backup drive is full.",
        action: {
          label: "Open",
          ariaLabel: "Open Photos backup",
          intent: "open-backup",
          payload: row,
        },
      },
    ]);
  });

  it("uses the fallback sentence when a failing backup has no reason", () => {
    const [item] = buildBackupItems({ backupRows: [drive({ state: "failing" })], ...ADMIN });
    expect(item.title).toEqual([{ name: "Photos" }, " backup didn't finish"]);
    expect(item.detail).toBe(FALLBACK);
  });

  it("titles a stale drive backup as not copied in a day, with the fallback detail", () => {
    const [item] = buildBackupItems({ backupRows: [drive({ state: "stale", last_error: "" })], ...ADMIN });
    expect(item.title).toEqual([{ name: "Photos" }, " hasn't been copied in a day"]);
    expect(item.detail).toBe(FALLBACK);
  });

  it("titles a cloud backup whose original is missing, with the missing-source detail", () => {
    const [item] = buildBackupItems({
      backupRows: [cloud({ source_missing: true, state: "ok", status: "active" })],
      ...ADMIN,
    });
    expect(item.id).toBe("backup:cloud:c1");
    expect(item.title).toEqual([{ name: "Documents" }, " backup can't find its original"]);
    expect(item.detail).toBe(MISSING);
  });

  it("uses the check problem as the detail when a cloud backup has only a check problem", () => {
    const [item] = buildBackupItems({
      backupRows: [cloud({ check_problem: "The cloud copy could not be read." })],
      ...ADMIN,
    });
    expect(item.title).toEqual([{ name: "Documents" }, " backup needs a look"]);
    expect(item.detail).toBe("The cloud copy could not be read.");
  });

  it("ports the card case: a failing cloud backup shows its reason", () => {
    const [item] = buildBackupItems({
      backupRows: [cloud({ state: "failing", last_error: "Cloud upload failed." })],
      ...ADMIN,
    });
    expect(item.title).toEqual([{ name: "Documents" }, " backup didn't finish"]);
    expect(item.detail).toBe("Cloud upload failed.");
  });

  it("prefers the reason text over the missing-source detail", () => {
    const [item] = buildBackupItems({
      backupRows: [cloud({ source_missing: true, last_error: "Gone.", state: "failing" })],
      ...ADMIN,
    });
    expect(item.detail).toBe("Gone.");
  });

  it("does not count a stopped backup, even when it is failing", () => {
    const rows = [drive({ status: "stopped", state: "failing", last_error: "old" })];
    expect(buildBackupItems({ backupRows: rows, ...ADMIN })).toEqual([]);
  });

  it("does not count a backup whose original was deleted", () => {
    const rows = [
      drive({ status: "source_gone", state: "failing", last_error: "old" }),
      cloud({ status: "source_gone", state: "failing", source_missing: true }),
    ];
    expect(buildBackupItems({ backupRows: rows, ...ADMIN })).toEqual([]);
  });

  it("produces nothing for healthy rows", () => {
    const rows = [drive(), cloud({ last_checked_at: 0 })];
    expect(buildBackupItems({ backupRows: rows, ...ADMIN })).toEqual([]);
  });

  it("returns an empty list for empty or missing rows", () => {
    expect(buildBackupItems({ backupRows: [], ...ADMIN })).toEqual([]);
    expect(buildBackupItems({ backupRows: undefined, ...ADMIN })).toEqual([]);
    expect(buildBackupItems({})).toEqual([]);
  });

  it("lets an Admin see another user's failing backup that is not private", () => {
    const [item] = buildBackupItems({
      backupRows: [drive({ id: "d9", state: "failing", created_by: "sam" })],
      ...ADMIN,
    });
    expect(item.id).toBe("backup:drive:d9");
  });

  it("never shows a private backup created by someone else, to an Admin or a Member", () => {
    const createdBySam = [drive({ state: "failing", private: true, created_by: "sam" })];
    const createdByAdmin = [drive({ state: "failing", private: true, created_by: "admin" })];
    expect(buildBackupItems({ backupRows: createdBySam, ...ADMIN })).toEqual([]);
    expect(buildBackupItems({ backupRows: createdByAdmin, ...MEMBER })).toEqual([]);
  });

  it("gives a Member only their own failing backups", () => {
    const rows = [
      drive({ id: "mine", state: "failing", created_by: "sam" }),
      drive({ id: "theirs", state: "failing", created_by: "admin" }),
    ];
    const items = buildBackupItems({ backupRows: rows, ...MEMBER });
    expect(items.map((item) => item.id)).toEqual(["backup:drive:mine"]);
  });

  it("returns items sorted by id", () => {
    const rows = [
      drive({ id: "b2", state: "failing" }),
      cloud({ id: "c1", state: "failing" }),
      drive({ id: "a1", state: "stale" }),
    ];
    const items = buildBackupItems({ backupRows: rows, ...ADMIN });
    expect(items.map((item) => item.id)).toEqual(["backup:cloud:c1", "backup:drive:a1", "backup:drive:b2"]);
  });
});

describe("buildPhraseItem", () => {
  it("returns the reminder for an Admin when a check is due and a cloud backup is visible", () => {
    expect(buildPhraseItem({ backupRows: [cloud()], phrase: { check_due: true }, ...ADMIN })).toEqual({
      id: "phrase-check",
      rank: 90,
      tone: "info",
      title: ["Check your recovery phrase"],
      detail: PHRASE_DETAIL,
      action: { label: "Check now", intent: "check-phrase" },
    });
  });

  it("returns null when the check is not due", () => {
    const rows = [cloud()];
    expect(buildPhraseItem({ backupRows: rows, phrase: { check_due: false }, ...ADMIN })).toBeNull();
    expect(buildPhraseItem({ backupRows: rows, phrase: {}, ...ADMIN })).toBeNull();
  });

  it("returns null when there is no phrase status", () => {
    const rows = [cloud()];
    expect(buildPhraseItem({ backupRows: rows, phrase: null, ...ADMIN })).toBeNull();
    expect(buildPhraseItem({ backupRows: rows, phrase: undefined, ...ADMIN })).toBeNull();
    expect(buildPhraseItem({ backupRows: rows, ...ADMIN })).toBeNull();
  });

  it("returns null when there are only drive backups", () => {
    expect(buildPhraseItem({ backupRows: [drive()], phrase: { check_due: true }, ...ADMIN })).toBeNull();
  });

  it("returns null when the only cloud backup is someone else's private row", () => {
    const rows = [cloud({ private: true, created_by: "sam" })];
    expect(buildPhraseItem({ backupRows: rows, phrase: { check_due: true }, ...ADMIN })).toBeNull();
  });

  it("returns null for a Member when the only cloud backup belongs to someone else", () => {
    const rows = [cloud({ created_by: "admin" })];
    expect(buildPhraseItem({ backupRows: rows, phrase: { check_due: true }, ...MEMBER })).toBeNull();
  });

  it("returns the reminder for a Member who owns a cloud backup", () => {
    const rows = [cloud({ created_by: "sam" })];
    const item = buildPhraseItem({ backupRows: rows, phrase: { check_due: true }, ...MEMBER });
    expect(item?.id).toBe("phrase-check");
    expect(item?.action).toEqual({ label: "Check now", intent: "check-phrase" });
  });
});
