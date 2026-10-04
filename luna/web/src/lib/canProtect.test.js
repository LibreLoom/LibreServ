import { describe, expect, it } from "vitest";
import { canProtect } from "./canProtect";

describe("canProtect", () => {
  it("is false with one drive and no cloud backup", () => {
    expect(canProtect({ driveCount: 1, cloudBackupConnected: false })).toBe(false);
  });

  it("is true with two drives (logical or, not bitwise)", () => {
    expect(canProtect({ driveCount: 2, cloudBackupConnected: false })).toBe(true);
    // Bitwise | with booleans is a common footgun; assert || semantics.
    expect(canProtect({ driveCount: 0, cloudBackupConnected: true })).toBe(true);
    expect(canProtect({ driveCount: 2, cloudBackupConnected: true })).toBe(true);
  });

  it("is true with one drive when cloud backup is connected", () => {
    expect(canProtect({ driveCount: 1, cloudBackupConnected: true })).toBe(true);
  });
});
