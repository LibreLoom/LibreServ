import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from"@libreloom/ui/context/ThemeContext.jsx";
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

  it("shows palette chips and reveals the editor only once colors are custom", async () => {
    const user = userEvent.setup();
    renderAppearance();

    expect(screen.getByRole("button", { name: /Use the default colors/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Background hex value")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Apply Ocean preset/i }));
    expect((/** @type {HTMLInputElement} */ (screen.getByLabelText("Background hex value"))).value).toBe("#cce7f5");
    expect(screen.getByLabelText("Text hex value")).toBeTruthy();
    expect(screen.getByLabelText("Accent hex value")).toBeTruthy();
  });

  it("Custom starts from the current colors and Default resets", async () => {
    const user = userEvent.setup();
    renderAppearance();

    await user.click(screen.getByRole("button", { name: /Make your own colors/i }));
    expect(screen.getByRole("button", { name: /Make your own colors/i }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Use the default colors/i }));
    await waitFor(() => expect(screen.queryByLabelText("Background hex value")).toBeNull());
    expect(localStorage.getItem("theme-colors")).toBeNull();
  });

  it("warns when the chosen colors are hard to read", async () => {
    const user = userEvent.setup();
    renderAppearance();

    await user.click(screen.getByRole("button", { name: /Make your own colors/i }));
    const text = screen.getByLabelText("Text hex value");
    await user.clear(text);
    await user.type(text, "#eeeeee");
    expect(screen.getByText(/hard to read/i)).toBeTruthy();
  });

  it("offers separate dark colors as a Flipped / Separate choice", async () => {
    const user = userEvent.setup();
    renderAppearance();

    await user.click(screen.getByRole("button", { name: /Apply Forest preset/i }));
    await user.click(screen.getByRole("radio", { name: /Separate/i }));
    expect(localStorage.getItem("theme-separate-dark")).toBe("true");
  });
});
