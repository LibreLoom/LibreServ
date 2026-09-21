import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_FIELD_PLACEHOLDER,
  meetsPasswordPolicy,
  passwordChecks,
  passwordPolicyError,
} from "./passwordPolicy";

describe("passwordPolicy", () => {
  it("matches backend minimum length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it("uses the setup password field placeholder", () => {
    expect(PASSWORD_FIELD_PLACEHOLDER).toBe('Not "a1!", please.');
  });

  it("rejects short passwords", () => {
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
  });

  it("accepts 12+ passwords with a letter and digit", () => {
    expect(meetsPasswordPolicy("hunter22hunter1")).toBe(true);
    expect(passwordPolicyError("hunter22hunter1")).toBeNull();
    expect(passwordChecks("hunter22hunter1").ok).toBe(true);
  });

  it("treats symbols as optional strength only", () => {
    const withSymbol = passwordChecks("hunter22hunter!");
    expect(withSymbol.ok).toBe(true);
    expect(withSymbol.hasSpecial).toBe(true);
  });
});
