import { describe, expect, it } from "vitest";
import { newPasswordProblem } from "./driveCrypt.js";

describe("newPasswordProblem", () => {
  it("allows a strong, matching password", () => {
    expect(newPasswordProblem("brand-new-pass-2", "brand-new-pass-2")).toBe("");
  });

  it("refuses a short password before the erase hand-off", () => {
    expect(newPasswordProblem("abc", "abc")).toBe("Passwords need at least 12 characters.");
  });

  it("counts UTF-8 bytes, as lunad does", () => {
    // Six characters, but eleven bytes — still too short for the drive.
    expect(newPasswordProblem("ééééé1", "ééééé1")).toBe("Passwords need at least 12 characters.");
  });

  it("still catches a mismatch once the policy is met", () => {
    expect(newPasswordProblem("brand-new-pass-2", "another-pass-3")).toBe(
      "The two passwords don't match.",
    );
  });
});
