import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
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
  // Desktop pill renders first, the mobile dialog second.
  const [desktop, mobile] = /** @type {HTMLElement[]} */ ([
    ...view.container.querySelectorAll('[data-slot="nav-group"]'),
  ]);
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

  it("is a layered pill: an accent-outlined track around the label chip", async () => {
    const { desktop } = renderAt("/");
    // The outline is always there, so the group reads as a container when folded.
    expect(desktop.className).toContain("surface-secondary");
    expect(desktop.className).toContain("border-accent");

    const files = within(desktop).getByRole("link", { name: "Files" });
    await act(async () => files.focus());
    expect(desktop).toHaveAttribute("data-open");
    // Open, the label is the inset primary chip in the secondary track.
    expect(files.className).toContain("surface-primary");
  });

  it("shows Files as selected inside Files, folded until hovered", async () => {
    vi.useFakeTimers();
    try {
      const { desktop } = renderAt("/drives/abc");
      const files = within(desktop).getByRole("link", { name: "Files" });
      expect(desktop).not.toHaveAttribute("data-open");
      expect(files).toHaveAttribute("aria-current", "page");

      fireEvent.pointerEnter(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(200));
      expect(desktop).toHaveAttribute("data-open");
      // Open, the sub-page carries the selection instead.
      expect(files).not.toHaveAttribute("aria-current");
      expect(within(desktop).getByRole("link", { name: "Drives" })).toHaveAttribute("aria-current", "page");
      expect(within(desktop).getByRole("link", { name: "Photos" })).not.toHaveAttribute("aria-current");

      fireEvent.pointerLeave(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(300));
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
      await act(async () => vi.advanceTimersByTime(60));
      expect(desktop).not.toHaveAttribute("data-open");
      await act(async () => vi.advanceTimersByTime(100));
      expect(desktop).toHaveAttribute("data-open");
      expect(desktop.querySelector("[inert]")).toBeNull();

      fireEvent.pointerLeave(desktop, { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTime(300));
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

  it("lists every sub-page under a Files heading in the mobile menu", () => {
    const { mobile } = renderAt("/shared");
    const group = mobile;
    expect(group).toHaveAttribute("role", "group");
    expect(group).toHaveAccessibleName("Files");
    const links = within(group).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Drives", "Shared", "Photos"]);
    expect(within(group).getByRole("link", { name: "Shared" })).toHaveAttribute("aria-current", "page");
  });
});
