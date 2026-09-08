import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_MAX,
  USERNAME_POLICY_HINT,
  displayNamePolicyError,
  isValidDisplayName,
  isValidUsername,
  usernamePolicyError,
} from "./usernamePolicy";

describe("usernamePolicy", () => {
  it("accepts usernames lunad would accept", () => {
    expect(isValidUsername("alex")).toBe(true);
    expect(isValidUsername("Alex.User-1_2")).toBe(true);
    expect(isValidUsername("  alex  ")).toBe(true);
  });

  it("rejects short, long, and illegal characters", () => {
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
    expect(isValidUsername("hello world")).toBe(false);
    expect(isValidUsername("hello!")).toBe(false);
    expect(usernamePolicyError("hello!")).toBe(USERNAME_POLICY_HINT);
    expect(usernamePolicyError("")).toBeNull();
  });

  it("allows empty display names and caps length at 80", () => {
    expect(isValidDisplayName("")).toBe(true);
    expect(isValidDisplayName("Alex")).toBe(true);
    expect(isValidDisplayName("x".repeat(DISPLAY_NAME_MAX))).toBe(true);
    expect(isValidDisplayName("x".repeat(DISPLAY_NAME_MAX + 1))).toBe(false);
    expect(displayNamePolicyError("x".repeat(DISPLAY_NAME_MAX + 1))).toMatch(/80/);
  });
});
