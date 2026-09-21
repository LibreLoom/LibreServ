import { describe, it, expect } from "vitest";

import { getBreakdownItems, totalResourceUsage } from "./resourceUtils";

const pct = (resources) => Math.round(totalResourceUsage(resources) * 100);

describe("totalResourceUsage", () => {
  it("is 0% when nothing is under load", () => {
    expect(pct({ cpu: 0, ram: 0, disk: 0, net: 0 })).toBe(0);
  });

  it("is 100% when a single resource is saturated", () => {
    expect(pct({ cpu: 0, ram: 0, disk: 0, net: 1 })).toBe(100);
    expect(pct({ cpu: 1, ram: 0, disk: 0, net: 0 })).toBe(100);
  });

  it("does not dilute a saturated resource with idle ones", () => {
    // The reported bug: net pegged, everything else quiet, index read ~30%.
    expect(pct({ cpu: 0.17, ram: 0.21, disk: 0.21, net: 1 })).toBe(100);
  });

  it("reports at least the worst resource's own load", () => {
    for (const load of [0.1, 0.35, 0.6, 0.9]) {
      expect(totalResourceUsage({ cpu: load, ram: 0, disk: 0, net: 0 })).toBeGreaterThanOrEqual(
        load,
      );
    }
  });

  it("rates broad load higher than a single busy resource", () => {
    const single = totalResourceUsage({ cpu: 0.5, ram: 0, disk: 0, net: 0 });
    const broad = totalResourceUsage({ cpu: 0.5, ram: 0.5, disk: 0.5, net: 0.5 });
    expect(single).toBe(0.5);
    expect(broad).toBeGreaterThan(single);
    expect(pct({ cpu: 0.5, ram: 0.5, disk: 0.5, net: 0.5 })).toBe(65);
  });

  it("never exceeds 100% and stays in range", () => {
    expect(totalResourceUsage({ cpu: 1, ram: 1, disk: 1, net: 1 })).toBe(1);
    expect(totalResourceUsage({ cpu: 0.99, ram: 0.99, disk: 0.99, net: 0.99 })).toBeLessThanOrEqual(1);
  });

  it("is symmetric across resources", () => {
    const a = totalResourceUsage({ cpu: 0.8, ram: 0.3, disk: 0.1, net: 0 });
    const b = totalResourceUsage({ cpu: 0, ram: 0.1, disk: 0.3, net: 0.8 });
    expect(a).toBeCloseTo(b, 10);
  });

  it("rises monotonically as any one resource climbs", () => {
    let previous = -1;
    for (let net = 0; net <= 1.0001; net += 0.05) {
      const value = totalResourceUsage({ cpu: 0.4, ram: 0.2, disk: 0.1, net });
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("treats missing, out-of-range and non-numeric readings as idle", () => {
    expect(totalResourceUsage({})).toBe(0);
    expect(totalResourceUsage(undefined)).toBe(0);
    expect(totalResourceUsage({ cpu: NaN, ram: null, disk: "x", net: 0.5 })).toBe(0.5);
    expect(totalResourceUsage({ cpu: -2, ram: 0, disk: 0, net: 3 })).toBe(1);
  });
});

describe("getBreakdownItems", () => {
  it("returns nothing without readings", () => {
    expect(getBreakdownItems(null)).toEqual([]);
  });

  it("labels each resource as a rounded percentage", () => {
    const items = getBreakdownItems({ cpu: 0.17, ram: 0.214, disk: 0.21, net: 1 });
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ["CPU", "17%"],
      ["RAM", "21%"],
      ["Disk", "21%"],
      ["Network", "100%"],
    ]);
    expect(items.every((i) => typeof i.icon === "function" || typeof i.icon === "object")).toBe(true);
  });

  it("clamps out-of-range readings", () => {
    const items = getBreakdownItems({ cpu: 1.4, ram: -0.2, disk: undefined, net: 0.5 });
    expect(items.map((i) => i.value)).toEqual(["100%", "0%", "0%", "50%"]);
  });
});
