import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { ThemeContext } from "../context/ThemeContext.jsx";
import { useTimeFormat } from "./useTimeFormat.jsx";

vi.mock("../lib/time-utils", () => ({
  formatTime: (date, use12) => use12 ? "02:30 PM" : "14:30",
  formatDateWithTime: (date, use12) => use12 ? "Jan 1, 2024, 02:30 PM" : "Jan 1, 2024, 14:30",
  formatDateLong: (date, use12) => use12 ? "January 1, 2024, 02:30 PM" : "January 1, 2024, 14:30",
}));

describe("useTimeFormat", () => {
  it("formats times in 12-hour mode", () => {
    const themeValue = { use12HourTime: true };
    const wrapper = ({ children }) => (
      <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>
    );
    const { result } = renderHook(() => useTimeFormat(), { wrapper });
    expect(result.current.use12HourTime).toBe(true);
    expect(result.current.formatTime(new Date())).toBe("02:30 PM");
  });

  it("formats times in 24-hour mode", () => {
    const themeValue = { use12HourTime: false };
    const wrapper = ({ children }) => (
      <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>
    );
    const { result } = renderHook(() => useTimeFormat(), { wrapper });
    expect(result.current.use12HourTime).toBe(false);
    expect(result.current.formatTime(new Date())).toBe("14:30");
  });

  it("throws when used outside ThemeProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useTimeFormat())).toThrow("useTimeFormat must be used within a ThemeProvider");
    consoleError.mockRestore();
  });
});
