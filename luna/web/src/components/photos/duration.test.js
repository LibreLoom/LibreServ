import { describe, expect, it } from "vitest";
import { fmtDuration, fmtDurationClock } from "./duration.js";

describe("fmtDuration", () => {
  it("rounds the total before splitting so seconds never reach 60", () => {
    expect(fmtDuration(59.4)).toBe("59 s");
    expect(fmtDuration(59.6)).toBe("1 min");
    expect(fmtDuration(60)).toBe("1 min");
    expect(fmtDuration(89.6)).toBe("1 min 30 s");
  });

  it("drops zero seconds at minute and hour boundaries", () => {
    expect(fmtDuration(120)).toBe("2 min");
    expect(fmtDuration(3599.6)).toBe("60 min");
  });

  it("returns null for missing or non-positive lengths", () => {
    expect(fmtDuration(undefined)).toBeNull();
    expect(fmtDuration(0)).toBeNull();
    expect(fmtDuration(-3)).toBeNull();
    expect(fmtDuration(Number.NaN)).toBeNull();
  });
});

describe("fmtDurationClock", () => {
  it("keeps the m:ss chip format", () => {
    expect(fmtDurationClock(12)).toBe("0:12");
    expect(fmtDurationClock(75)).toBe("1:15");
    expect(fmtDurationClock(59.6)).toBe("1:00");
  });
});
