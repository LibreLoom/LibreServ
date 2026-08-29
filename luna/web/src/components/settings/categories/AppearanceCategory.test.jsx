import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../../../context/ThemeContext";
import AppearanceCategory from "./AppearanceCategory";

function renderAppearance() {
  return render(
    <ThemeProvider>
      <AppearanceCategory />
    </ThemeProvider>,
  );
}

describe("AppearanceCategory", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    window.matchMedia = (query) => ({
      matches: false,
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

  it("shows System / Light / Dark segmented control", () => {
    renderAppearance();
    expect(screen.getByRole("radio", { name: /System/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Light$/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Dark$/i })).toBeTruthy();
  });

  it("switches to dark and persists theme", async () => {
    const user = userEvent.setup();
    renderAppearance();

    await user.click(screen.getByRole("radio", { name: /^Dark$/i }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("switches to light and persists theme", async () => {
    const user = userEvent.setup();
    localStorage.setItem("theme", "dark");
    renderAppearance();

    await act(async () => {
      await user.click(screen.getByRole("radio", { name: /^Light$/i }));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("exposes custom colors toggle", async () => {
    const user = userEvent.setup();
    renderAppearance();

    expect(screen.getByText("Enable Custom Colors")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: /Enable Custom Colors/i }));
    expect(screen.getByText("Color Presets")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apply Classic preset/i })).toBeTruthy();
  });
});
