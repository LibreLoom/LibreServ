import { describe, it, expect } from "vitest";
import {
  hashString,
  normalizePathname,
  getPrimarySegment,
  levenshteinDistance,
  scoreKnownPages,
  pickStableQuip,
  bestDistinctMatches,
  guessSearchTerm,
  moonPhase,
  moonIllumination,
  moonPhaseName,
  moonLitPath,
} from "./notFoundHelpers";

const knownPages = [
  { to: "/drives", label: "Files" },
  { to: "/gallery", label: "Photos" },
  { to: "/settings", label: "Settings" },
  { to: "/settings/users", label: "Users" },
  { to: "/login", label: "Login" },
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
    const matches = scoreKnownPages("/drives", knownPages);
    expect(matches[0].to).toBe("/drives");
    expect(matches[0].score).toBe(0);
    expect(matches[0].isClose).toBe(true);
  });

  it("flags a one-letter typo as a close match", () => {
    // "galery" vs "gallery" — one deletion.
    const matches = scoreKnownPages("/galery", knownPages);
    expect(matches[0].to).toBe("/gallery");
    expect(matches[0].isClose).toBe(true);
    expect(matches[0].lettersOff).toBe(1);
  });

  it("does not flag an unrelated path as close", () => {
    const matches = scoreKnownPages("/xyz", knownPages);
    expect(matches.some((m) => m.isClose)).toBe(false);
  });

  it("returns every known page, scored and sorted best-first", () => {
    const matches = scoreKnownPages("/drives", knownPages);
    expect(matches).toHaveLength(knownPages.length);
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i - 1].score).toBeLessThanOrEqual(matches[i].score);
    }
  });

  it("is deterministic across calls with the same input", () => {
    const a = scoreKnownPages("/galery", knownPages).map((m) => m.to);
    const b = scoreKnownPages("/galery", knownPages).map((m) => m.to);
    expect(a).toEqual(b);
  });

  it("treats a path prefix of a known route as a close match", () => {
    // /drives/anything is a prefix-extension of /drives.
    const matches = scoreKnownPages("/drives/123", knownPages);
    expect(matches[0].to).toBe("/drives");
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
describe("scoreKnownPages aliases", () => {
  it("scores an alias on behalf of its real route", () => {
    const pages = [{ to: "/gallery", label: "Photos", match: "/pictures" }];
    const [best] = scoreKnownPages("/pictures", pages);
    expect(best.isClose).toBe(true);
    expect(best.to).toBe("/gallery");
  });
});

describe("bestDistinctMatches", () => {
  it("keeps one suggestion per destination", () => {
    const pages = [
      { to: "/drives", label: "Files", match: "/files" },
      { to: "/drives", label: "Files", match: "/file" },
    ];
    const out = bestDistinctMatches(scoreKnownPages("/files", pages));
    expect(out).toHaveLength(1);
  });

  it("returns nothing when no page is close", () => {
    expect(bestDistinctMatches(scoreKnownPages("/zzzzzz", knownPages))).toEqual([]);
  });
});

describe("guessSearchTerm", () => {
  it("decodes file names and keeps their punctuation", () => {
    expect(guessSearchTerm("/Documents/Tax%202024.pdf")).toBe("Tax 2024.pdf");
    expect(guessSearchTerm("/a/my_notes-v2.md")).toBe("my_notes-v2.md");
  });

  it("turns slugs into words", () => {
    expect(guessSearchTerm("/summer-trip_2024")).toBe("summer trip 2024");
  });

  it("survives malformed escapes and empty paths", () => {
    expect(guessSearchTerm("/bad%E0%A4%A")).toBe("bad%E0%A4%A");
    expect(guessSearchTerm("/")).toBe("");
    expect(guessSearchTerm("/x")).toBe("");
  });
});

describe("moon phase", () => {
  it("is new at a known new moon and full about 14.8 days later", () => {
    const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14));
    expect(moonPhase(newMoon)).toBeCloseTo(0, 3);
    const full = new Date(newMoon.getTime() + 14.765 * 86_400_000);
    expect(moonPhase(full)).toBeCloseTo(0.5, 3);
    expect(moonPhaseName(moonPhase(full))).toBe("Full moon");
  });

  it("stays in [0, 1) before the reference date", () => {
    const p = moonPhase(new Date(Date.UTC(1990, 5, 1)));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  });

  it("lights none of the disc at new moon and all of it at full", () => {
    expect(moonIllumination(0)).toBeCloseTo(0);
    expect(moonIllumination(0.5)).toBeCloseTo(1);
    expect(moonLitPath(0, 50, 50, 45)).toBe("");
    expect(moonLitPath(0.5, 50, 50, 45)).toMatch(/^M 50 5 A 45 45/);
  });

  it("lights the right side while waxing and the left while waning", () => {
    // Limb arc sweep flag: 1 = clockwise via the right, 0 = via the left.
    expect(moonLitPath(0.2, 50, 50, 45)).toMatch(/A 45 45 0 0 1 50 95/);
    expect(moonLitPath(0.8, 50, 50, 45)).toMatch(/A 45 45 0 0 0 50 95/);
  });

  it("names the quarters", () => {
    expect(moonPhaseName(0.25)).toBe("First quarter");
    expect(moonPhaseName(0.75)).toBe("Last quarter");
    expect(moonPhaseName(0.98)).toBe("New moon");
  });
});
