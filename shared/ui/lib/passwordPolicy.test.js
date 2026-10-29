import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_FIELD_PLACEHOLDER,
  meetsPasswordPolicy,
  passwordChecks,
  passwordPolicyError,
} from "./passwordPolicy";

describe("passwordPolicy", () => {
  it("matches Luna backend minimum length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it("uses the setup password field placeholder", () => {
    expect(PASSWORD_FIELD_PLACEHOLDER).toBe('Not "a1!", please.');
  });

  it("rejects short passwords with the same message as lunad", () => {
    expect(meetsPasswordPolicy("abc123")).toBe(false);
    expect(passwordPolicyError("abc123")).toBe(
      "Passwords need at least 12 characters.",
    );
  });

  it("rejects long passwords missing a letter or number", () => {
    expect(meetsPasswordPolicy("abcdefghijkl")).toBe(false);
    expect(passwordPolicyError("abcdefghijkl")).toBe(
      "Passwords need at least one letter and one number.",
    );
    expect(meetsPasswordPolicy("123456789012")).toBe(false);
    expect(passwordPolicyError("123456789012")).toBe(
      "Passwords need at least one letter and one number.",
    );
  });

  it("accepts Sol-style passwords (12+ with letter and digit)", () => {
    expect(meetsPasswordPolicy("hunter22hunter1")).toBe(true);
    expect(passwordPolicyError("hunter22hunter1")).toBeNull();
    expect(passwordChecks("hunter22hunter1").ok).toBe(true);
  });

  it("treats symbols as optional strength only", () => {
    const withSymbol = passwordChecks("hunter22hunter!");
    expect(withSymbol.ok).toBe(true);
    expect(withSymbol.hasSpecial).toBe(true);
    const without = passwordChecks("hunter22hunter1");
    expect(without.ok).toBe(true);
    expect(without.hasSpecial).toBe(false);
  });

  it("can count UTF-8 bytes without changing the default character count", () => {
    const password = "é".repeat(9) + "a1";

    expect(passwordChecks(password).hasLength).toBe(false);
    expect(passwordChecks(password, { lengthUnit: "utf8-bytes" }).hasLength).toBe(true);
    expect(passwordPolicyError(password, { lengthUnit: "utf8-bytes" })).toBeNull();
    expect(meetsPasswordPolicy(password, { lengthUnit: "utf8-bytes" })).toBe(true);
    expect(passwordPolicyError("é".repeat(4) + "a1", { lengthUnit: "utf8-bytes" })).toContain("12 characters");
  });
});
