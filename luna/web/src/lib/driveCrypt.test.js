import { describe, expect, it } from "vitest";
import { newPasswordProblem } from "./driveCrypt.js";

describe("newPasswordProblem", () => {
  it("allows a strong, matching password", () => {
    expect(newPasswordProblem("brand-new-pass-2", "brand-new-pass-2")).toBe("");
  });

  it("refuses a short password before the erase hand-off", () => {
    expect(newPasswordProblem("abc", "abc")).toBe("Passwords need at least 12 characters.");
  });

  it("counts characters, as lunad and the strength checklist do", () => {
    // 11 characters but 19 UTF-8 bytes — with an ASCII letter and digit, a
    // byte count would accept it. Only the character count refuses it.
    const short = `${"é".repeat(9)}a1`;
    expect(newPasswordProblem(short, short)).toBe("Passwords need at least 12 characters.");
  });

  it("accepts twelve characters even when they are multi-byte", () => {
    const longEnough = `${"é".repeat(10)}a1`;
    expect(newPasswordProblem(longEnough, longEnough)).toBe("");
  });

  it("still catches a mismatch once the policy is met", () => {
    expect(newPasswordProblem("brand-new-pass-2", "another-pass-3")).toBe(
      "The two passwords don't match.",
    );
  });
});
