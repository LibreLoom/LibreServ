import { describe, expect, it } from "vitest";
import {
  meetsPasswordPolicy,
  passwordChecks,
  PASSWORD_POLICY_HELPER,
} from "./passwordPolicy.js";

describe("passwordPolicy", () => {
  it("exports the onboarding helper copy", () => {
    expect(PASSWORD_POLICY_HELPER).toBe(
      "Use at least 12 characters, including a letter and a number.",
    );
  });

  it("requires 12+ chars, a letter, and a number", () => {
    expect(meetsPasswordPolicy("short")).toBe(false);
    expect(meetsPasswordPolicy("longpassword")).toBe(false);
    expect(meetsPasswordPolicy("123456789012")).toBe(false);
    expect(meetsPasswordPolicy("password1234")).toBe(true);
  });

  it("tracks each requirement and strength score", () => {
    const empty = passwordChecks("");
    expect(empty.hasLength).toBe(false);
    expect(empty.hasLetter).toBe(false);
    expect(empty.hasDigit).toBe(false);
    expect(empty.hasSpecial).toBe(false);
    expect(empty.score).toBe(0);
    expect(empty.ok).toBe(false);

    const partial = passwordChecks("abc");
    expect(partial.hasLetter).toBe(true);
    expect(partial.hasLength).toBe(false);
    expect(partial.hasDigit).toBe(false);
    expect(partial.score).toBe(1);

    const strong = passwordChecks("password1234!");
    expect(strong.ok).toBe(true);
    expect(strong.hasSpecial).toBe(true);
    expect(strong.score).toBe(4);
  });
});
