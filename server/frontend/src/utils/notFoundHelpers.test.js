import { describe, it, expect } from "vitest";
import {
  hashString,
  normalizePathname,
  getPrimarySegment,
  levenshteinDistance,
  scoreKnownPages,
  pickStableQuip,
} from "./notFoundHelpers";

const knownPages = [
  { to: "/apps", label: "Apps" },
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
  { to: "/lore", label: "Lore" },
];

describe("hashString", () => {
  it("is deterministic for the same input", () => {
    expect(hashString("/apps")).toBe(hashString("/apps"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashString("/apps")).not.toBe(hashString("/users"));
  });

  it("returns a non-negative integer", () => {
    const h = hashString("anything");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });
});

describe("normalizePathname", () => {
  it.each([
    ["empty", "", "/"],
    ["null", null, "/"],
    ["undefined", undefined, "/"],
    ["whitespace-only", "   ", "/"],
    ["trailing slash", "/apps/", "/apps"],
    ["many trailing slashes", "/apps///", "/apps"],
    ["bare root", "/", "/"],
    ["preserves nested path", "/apps/123", "/apps/123"],
  ])("handles %s", (_label, input, expected) => {
    expect(normalizePathname(input)).toBe(expected);
  });
});

describe("getPrimarySegment", () => {
  it.each([
    ["/apps", "apps"],
    ["/apps/123", "apps"],
    ["/", ""],
    ["", ""],
    ["apps", "apps"],
  ])("%s -> %s", (input, expected) => {
    expect(getPrimarySegment(input)).toBe(expected);
  });
});

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("apps", "apps")).toBe(0);
  });

  it("equals the other string's length when one is empty", () => {
    expect(levenshteinDistance("", "apps")).toBe(4);
    expect(levenshteinDistance("apps", "")).toBe(4);
  });

  it("matches known edit-distance values", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("flaw", "lawn")).toBe(2);
    expect(levenshteinDistance("apbs", "apps")).toBe(1);
  });
});

describe("scoreKnownPages", () => {
  it("ranks an exact match first with a close, zero-cost score", () => {
    const matches = scoreKnownPages("/apps", knownPages);
    expect(matches[0].to).toBe("/apps");
    expect(matches[0].score).toBe(0);
    expect(matches[0].isClose).toBe(true);
  });

  it("flags a one-letter typo as a close match", () => {
    // "apbs" vs "apps" — one substitution.
    const matches = scoreKnownPages("/apbs", knownPages);
    expect(matches[0].to).toBe("/apps");
    expect(matches[0].isClose).toBe(true);
    expect(matches[0].lettersOff).toBe(1);
  });

  it("does not flag an unrelated path as close", () => {
    const matches = scoreKnownPages("/xyz", knownPages);
    expect(matches.some((m) => m.isClose)).toBe(false);
  });

  it("returns every known page, scored and sorted best-first", () => {
    const matches = scoreKnownPages("/apps", knownPages);
    expect(matches).toHaveLength(knownPages.length);
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i - 1].score).toBeLessThanOrEqual(matches[i].score);
    }
  });

  it("is deterministic across calls with the same input", () => {
    const a = scoreKnownPages("/apbs", knownPages).map((m) => m.to);
    const b = scoreKnownPages("/apbs", knownPages).map((m) => m.to);
    expect(a).toEqual(b);
  });

  it("treats a path prefix of a known route as a close match", () => {
    // /apps/anything is a prefix-extension of /apps.
    const matches = scoreKnownPages("/apps/123", knownPages);
    expect(matches[0].to).toBe("/apps");
    expect(matches[0].isClose).toBe(true);
  });
});

describe("pickStableQuip", () => {
  const quips = ["alpha", "beta", "gamma"];

  it("returns a stable quip for the same attempted path", () => {
    expect(pickStableQuip("/apps", quips)).toBe(pickStableQuip("/apps", quips));
  });

  it("only ever returns one of the provided quips", () => {
    const picked = pickStableQuip("/some/path", quips);
    expect(quips).toContain(picked);
  });

  it("returns an empty string when no quips are available", () => {
    expect(pickStableQuip("/apps", [])).toBe("");
    expect(pickStableQuip("/apps", null)).toBe("");
  });
});