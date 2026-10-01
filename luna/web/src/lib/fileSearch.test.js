import { describe, expect, it } from "vitest";
import { locationParts, parseSearchResponse, searchWhen } from "./fileSearch.js";

describe("locationParts", () => {
  it("shows the drive alone for the top level", () => {
    expect(locationParts("Photos", "")).toEqual(["Photos"]);
  });

  it("keeps short paths whole", () => {
    expect(locationParts("Photos", "2024/Spain")).toEqual(["Photos", "2024", "Spain"]);
  });

  it("drops the middle of long paths so the last folders stay", () => {
    expect(locationParts("Photos", "a/b/c/Spain")).toEqual(["Photos", "…", "c", "Spain"]);
  });
});

describe("searchWhen", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const secs = (ms) => Math.floor((now - ms) / 1000);

  it("is empty when the time is unknown", () => {
    expect(searchWhen(0, now)).toBe("");
  });

  it("is relative for the last week", () => {
    expect(searchWhen(secs(5 * 60_000), now)).toBe("5 min ago");
    expect(searchWhen(secs(3 * 3_600_000), now)).toBe("3 h ago");
    expect(searchWhen(secs(86_400_000), now)).toBe("1 day ago");
  });

  it("adds the year once a file is from an earlier year", () => {
    const old = Math.floor(Date.UTC(2023, 2, 4, 12) / 1000);
    expect(searchWhen(old, now)).toMatch(/2023/);
    const thisYear = Math.floor(Date.UTC(2026, 0, 4, 12) / 1000);
    expect(searchWhen(thisYear, now)).not.toMatch(/2026/);
  });
});

describe("parseSearchResponse", () => {
  it("reads the truncated flag and tolerates an empty answer", () => {
    expect(parseSearchResponse({ hits: [], truncated: true }).truncated).toBe(true);
    expect(parseSearchResponse(undefined)).toEqual({ hits: [], closeOnly: false, truncated: false, scan: null });
  });
});
