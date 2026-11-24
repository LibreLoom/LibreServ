import { describe, expect, it } from "vitest";
import { isPausedByLock, newPasswordProblem } from "./driveCrypt.js";

describe("newPasswordProblem", () => {
  it("accepts any non-empty password, even a short one", () => {
    // lunad only rejects an empty password for a drive; there is no account-style
    // length or letter/number rule here.
    expect(newPasswordProblem("abc", "abc")).toBe("");
  });

  it("accepts a short multi-byte password too", () => {
    const short = "é".repeat(9); // 9 characters, 18 UTF-8 bytes
    expect(newPasswordProblem(short, short)).toBe("");
  });

  it("accepts a long, matching password", () => {
    expect(newPasswordProblem("brand-new-pass-2", "brand-new-pass-2")).toBe("");
  });

  it("refuses an empty password", () => {
    expect(newPasswordProblem("", "")).toBe("Enter a password.");
  });

  it("reports the empty password before a mismatch", () => {
    expect(newPasswordProblem("", "abc")).toBe("Enter a password.");
  });

  it("catches a mismatch, even on a short password", () => {
    expect(newPasswordProblem("abc", "abd")).toBe("The two passwords don't match.");
  });
});

describe("isPausedByLock (re-exported for the backup UI)", () => {
  it("stays the single definition shared with backupRows", () => {
    const paused = { paused: "locked", status: "active" };
    expect(isPausedByLock(paused)).toBe(true);
    expect(isPausedByLock({ ...paused, status: "stopped" })).toBe(false);
  });
});
