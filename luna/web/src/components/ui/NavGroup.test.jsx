import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import { HOVER_INTENT } from "@libreloom/ui/lib/ui-tokens.js";
import Navbar from "./Navbar";

afterEach(() => {
  window.localStorage.removeItem("navGroup:files");
  vi.unstubAllGlobals();
});

function stubAuthApi() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderAt(path) {
  stubAuthApi();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Navbar />
      </AuthProvider>
    </MemoryRouter>,
  );
  // Only the desktop pill is a group; the phone menu is a plain list.
  const desktop = /** @type {HTMLElement} */ (view.container.querySelector('[data-slot="nav-group"]'));
  const mobile = screen.getAllByRole("navigation", { name: "Primary" })[1];
  return { ...view, desktop, mobile };
}

describe("Files nav group", () => {
  it("replaces Photos, Drives and Shared as top-level items with one Files item", () => {
    const { desktop } = renderAt("/");
    const subPages = within(desktop).getAllByRole("link").slice(1);
    const primary = screen.getAllByRole("navigation", { name: "Primary" })[0];
    const topLevel = within(primary)
      .getAllByRole("link")
      .filter((a) => !subPages.includes(a))
      .map((a) => a.textContent);
    expect(topLevel).toEqual(["Home", "Files", "Settings"]);
  });

  it("stays a closed pill pointing at Drives outside Files", () => {
    const { desktop } = renderAt("/");
    expect(desktop).not.toHaveAttribute("data-open");
    expect(within(desktop).getByRole("link", { name: "Files" })).toHaveAttribute("href", "/drives");
    // Collapsed sub-pages are out of the tab order.
    expect(desktop.querySelector("[inert]")).not.toBeNull();
  });

  it("shows Files as selected inside Files, folded until hovered", async () => {
    vi.useFakeTimers();
    try {
      const { desktop } = renderAt("/drives/abc");
      const files = within(desktop).getByRole("link", { name: "Files" });
      expect(desktop).not.toHaveAttribute("data-open");
      expect(files).toHaveAttribute("aria-current", "page");

      fireEvent.pointerEnter(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(HOVER_INTENT.openMs));
      expect(desktop).toHaveAttribute("data-open");
      // Open, the sub-page carries the selection instead.
      expect(files).not.toHaveAttribute("aria-current");
      expect(within(desktop).getByRole("link", { name: "Drives" })).toHaveAttribute("aria-current", "page");
      expect(within(desktop).getByRole("link", { name: "Photos" })).not.toHaveAttribute("aria-current");

      fireEvent.pointerLeave(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(HOVER_INTENT.closeMs));
      expect(desktop).not.toHaveAttribute("data-open");
      expect(files).toHaveAttribute("aria-current", "page");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens the sub-page you used last", () => {
    const first = renderAt("/gallery");
    expect(window.localStorage.getItem("navGroup:files")).toBe("/gallery");
    first.unmount();

    const { desktop } = renderAt("/settings");
    expect(within(desktop).getByRole("link", { name: "Files" })).toHaveAttribute("href", "/gallery");
  });

  it("unfolds on mouse hover and folds back after the pointer leaves", async () => {
    vi.useFakeTimers();
    try {
      const { desktop } = renderAt("/");
      fireEvent.pointerEnter(desktop, { pointerType: "mouse" });
      // A quick sweep across the bar doesn't open it.
      await act(async () => vi.advanceTimersByTime(HOVER_INTENT.openMs - 1));
      expect(desktop).not.toHaveAttribute("data-open");
      await act(async () => vi.advanceTimersByTime(1));
      expect(desktop).toHaveAttribute("data-open");
      expect(desktop.querySelector("[inert]")).toBeNull();

      fireEvent.pointerLeave(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(HOVER_INTENT.closeMs));
      expect(desktop).not.toHaveAttribute("data-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unfolds for keyboard focus and folds on Escape, keeping focus on Files", async () => {
    const { desktop } = renderAt("/");
    const files = within(desktop).getByRole("link", { name: "Files" });
    await act(async () => files.focus());
    expect(desktop).toHaveAttribute("data-open");

    const drives = within(desktop).getByRole("link", { name: "Drives" });
    await act(async () => drives.focus());
    fireEvent.keyDown(drives, { key: "Escape" });
    await act(async () => {});
    expect(desktop).not.toHaveAttribute("data-open");
    expect(files).toHaveFocus();
  });

  it("keeps the phone menu a plain list, with the sub-pages as ordinary rows", () => {
    const { mobile } = renderAt("/shared");
    expect(within(mobile).queryByRole("group")).toBeNull();
    expect(mobile.querySelector('[data-slot="nav-group"]')).toBeNull();
    const links = within(mobile).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Home", "Drives", "Shared", "Photos", "Settings"]);
    expect(within(mobile).getByRole("link", { name: "Shared" })).toHaveAttribute("aria-current", "page");
    // Same row styling as Home (the router adds "active" to the current one).
    const rowClasses = (/** @type {string} */ name) =>
      within(mobile).getByRole("link", { name }).className.replace(/\bactive\b/, "").trim();
    expect(rowClasses("Shared")).toBe(rowClasses("Home"));
  });
});
