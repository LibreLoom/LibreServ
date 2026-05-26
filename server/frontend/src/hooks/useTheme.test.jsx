import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { ThemeContext } from "../context/ThemeContext.jsx";
import { useTheme } from "./useTheme.jsx";

describe("useTheme", () => {
  it("returns context value when used within ThemeProvider", () => {
    const mockTheme = {
      theme: "dark",
      resolvedTheme: "dark",
      toggleTheme: () => {},
      colors: { primary: "#000", secondary: "#fff", accent: "#767676" },
    };
    const wrapper = ({ children }) => (
      <ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
    );
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("throws when used outside ThemeProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow("useTheme must be used within a ThemeProvider");
    consoleError.mockRestore();
  });
});
