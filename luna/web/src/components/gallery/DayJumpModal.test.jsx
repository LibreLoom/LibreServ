import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DayJumpModal, { dayBoundsLocal, nearestDayKey } from "./DayJumpModal.jsx";

const ts = (y, m, d) => Math.floor(new Date(y, m - 1, d).getTime() / 1000);

const PHOTOS = [
  { taken_at: ts(2024, 3, 10) },
  { taken_at: ts(2024, 3, 11) },
  { taken_at: ts(2024, 7, 1) },
  { taken_at: ts(2023, 12, 25) },
  { taken_at: null },
];

describe("dayBoundsLocal", () => {
  it("returns local-day unix bounds and a label for a valid date", () => {
    const bounds = dayBoundsLocal("2024-03-15");
    expect(bounds).not.toBeNull();
    expect(bounds.from).toBe(ts(2024, 3, 15));
    expect(bounds.label).toMatch(/2024/);
  });

  it("rejects empty and partial input", () => {
    expect(dayBoundsLocal("")).toBeNull();
    expect(dayBoundsLocal("2024-03")).toBeNull();
  });
});

describe("nearestDayKey", () => {
  it("returns the exact day when it exists", () => {
    expect(nearestDayKey(PHOTOS, "2024-03-11")).toBe("2024-03-11");
  });

  it("lands on the closest day when the picked day has no photos", () => {
    // 2024-03-20 is closer to 2024-03-11 than to 2024-07-01
    expect(nearestDayKey(PHOTOS, "2024-03-20")).toBe("2024-03-11");
    // 2024-05-20 is closer to 2024-07-01 than to 2024-03-11
    expect(nearestDayKey(PHOTOS, "2024-05-20")).toBe("2024-07-01");
  });

  it("clamps to the newest or oldest loaded day when out of range", () => {
    expect(nearestDayKey(PHOTOS, "2030-01-01")).toBe("2024-07-01");
    expect(nearestDayKey(PHOTOS, "2000-01-01")).toBe("2023-12-25");
  });

  it("skips undated photos and empty lists", () => {
    expect(nearestDayKey([{ taken_at: null }], "2024-01-01")).toBeNull();
    expect(nearestDayKey([], "2024-01-01")).toBeNull();
  });
});

describe("DayJumpModal", () => {
  it("jumps as soon as a complete day is picked", () => {
    const onJump = vi.fn();
    render(<DayJumpModal open onJump={onJump} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Day to jump to/i), {
      target: { value: "2024-03-15" },
    });
    expect(onJump).toHaveBeenCalledWith("2024-03-15");
  });

  it("ignores partial input that does not form a full date", () => {
    const onJump = vi.fn();
    render(<DayJumpModal open onJump={onJump} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Day to jump to/i), {
      target: { value: "2024-03" },
    });
    expect(onJump).not.toHaveBeenCalled();
  });
});
