import { useContext } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeContext, ThemeProvider } from "./ThemeContext.jsx";

let mediaHandler;
let mediaMatches;
let removeMediaListener;

function renderTheme() {
  const wrapper = ({ children }) => (
    <ThemeProvider>{children}</ThemeProvider>
  );
  return renderHook(() => useContext(ThemeContext), { wrapper });
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    mediaHandler = undefined;
    mediaMatches = false;
    removeMediaListener = vi.fn();
    window.matchMedia = vi.fn(() => ({
      get matches() {
        return mediaMatches;
      },
      addEventListener: vi.fn((_event, handler) => {
        mediaHandler = handler;
      }),
      removeEventListener: removeMediaListener,
    }));
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback) => {
        callback();
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.noThemeTransition;
    delete document.documentElement.dataset.themeTransitioning;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves system preference and updates persisted settings", async () => {
    const { result } = renderTheme();

    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("light");
    expect(result.current.colors).toEqual({
      primary: "#ffffff",
      secondary: "#000000",
      accent: "#767676",
    });
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#ffffff",
    );

    act(() => mediaHandler({ matches: true }));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    act(() => result.current.setTheme("light"));
    expect(result.current.resolvedTheme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");

    act(() => result.current.setUse12HourTime(1));
    expect(result.current.use12HourTime).toBe(true);
    expect(localStorage.getItem("use12HourTime")).toBe("true");
  });

  it("cycles themes in system, light, dark order", () => {
    const { result } = renderTheme();

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("dark");
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("system");
  });

  it("sanitizes custom colors and derives dark colors by inversion", () => {
    const { result } = renderTheme();

    act(() =>
      result.current.setColors({
        primary: "#112233",
        secondary: "#aabbcc",
        accent: "invalid",
      }),
    );
    expect(result.current.colors).toEqual({
      primary: "#112233",
      secondary: "#aabbcc",
      accent: "#767676",
    });
    expect(result.current.isCustomTheme).toBe(true);
    expect(localStorage.getItem("theme-colors")).toContain("#112233");

    act(() => result.current.setTheme("dark"));
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#aabbcc",
    );
    expect(document.documentElement.style.getPropertyValue("--secondary")).toBe(
      "#112233",
    );

    act(() => result.current.setColors(null));
    expect(result.current.isCustomTheme).toBe(false);
    expect(result.current.colors.primary).toBe("#000000");
    expect(localStorage.getItem("theme-colors")).toBeNull();
  });

  it("supports separate dark colors and resets all custom colors", () => {
    const { result } = renderTheme();

    act(() => {
      result.current.setColors({
        primary: "#eeeeee",
        secondary: "#111111",
        accent: "#777777",
      });
      result.current.setDarkColors({
        primary: "#101010",
        secondary: "bad",
        accent: "#abcdef",
      });
      result.current.setUseSeparateDarkColors("yes");
      result.current.setTheme("dark");
    });

    expect(result.current.useSeparateDarkColors).toBe(true);
    expect(result.current.darkColors).toEqual({
      primary: "#101010",
      secondary: "#ffffff",
      accent: "#abcdef",
    });
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#101010",
    );
    expect(localStorage.getItem("theme-dark-colors")).toContain("#101010");

    act(() => result.current.setDarkColors(null));
    expect(result.current.darkColors).toEqual({
      primary: "#000000",
      secondary: "#ffffff",
      accent: "#767676",
    });

    act(() => result.current.resetColors());
    expect(result.current.isCustomTheme).toBe(false);
    expect(result.current.darkColors).toBeNull();
    expect(result.current.useSeparateDarkColors).toBe(false);
    expect(localStorage.getItem("theme-dark-colors")).toBeNull();
  });

  it("loads stored values and removes invalid JSON", () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("use12HourTime", "true");
    localStorage.setItem("theme-separate-dark", "true");
    localStorage.setItem(
      "theme-colors",
      JSON.stringify({
        primary: "#123456",
        secondary: "#abcdef",
        accent: "#654321",
      }),
    );
    localStorage.setItem("theme-dark-colors", "{broken");

    const { result } = renderTheme();

    expect(result.current.theme).toBe("dark");
    expect(result.current.use12HourTime).toBe(true);
    expect(result.current.useSeparateDarkColors).toBe(true);
    expect(result.current.colors.primary).toBe("#123456");
    expect(result.current.darkColors.primary).toBe("#000000");
    expect(localStorage.getItem("theme-dark-colors")).toBeNull();
  });

  it("falls back from invalid stored theme and cleans up listeners", async () => {
    localStorage.setItem("theme", "sepia");
    const { result, unmount } = renderTheme();

    expect(result.current.theme).toBe("system");
    await waitFor(() => expect(mediaHandler).toBeTypeOf("function"));
    unmount();

    expect(removeMediaListener).toHaveBeenCalledWith("change", mediaHandler);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(document.documentElement.dataset.themeTransitioning).toBeUndefined();
  });
});
