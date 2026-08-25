import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ThemeProvider } from "./ThemeContext";
import { useTheme } from "../hooks/useTheme";

function Probe({ onReady }) {
  const theme = useTheme();
  onReady(theme);
  return null;
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("--primary");
    window.matchMedia = (query) => ({
      matches: String(query).includes("prefers-color-scheme: dark"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to system and applies resolved class", () => {
    let api;
    render(
      <ThemeProvider>
        <Probe onReady={(t) => { api = t; }} />
      </ThemeProvider>,
    );
    expect(api.theme).toBe("system");
    expect(api.resolvedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists theme choice to localStorage", () => {
    let api;
    render(
      <ThemeProvider>
        <Probe onReady={(t) => { api = t; }} />
      </ThemeProvider>,
    );

    act(() => {
      api.setTheme("light");
    });

    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // color-scan: ignore-next-line -- asserting theme CSS variable value
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#ffffff");
  });

  it("restores stored theme on mount", () => {
    localStorage.setItem("theme", "dark");
    let api;
    render(
      <ThemeProvider>
        <Probe onReady={(t) => { api = t; }} />
      </ThemeProvider>,
    );
    expect(api.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // color-scan: ignore-next-line -- asserting theme CSS variable value
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#000000");
  });
});
