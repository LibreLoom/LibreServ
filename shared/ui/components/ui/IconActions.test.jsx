import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Copy, Download, FolderOpen, Trash2 } from "lucide-react";
import IconActions from "./IconActions.jsx";

vi.mock("../../utils/haptics.js", () => ({ haptic: vi.fn() }));
const { haptic } = await import("../../utils/haptics.js");

function renderRow(props = {}) {
  const onCopy = vi.fn();
  const onTrash = vi.fn();
  const onGo = vi.fn();
  render(
    <MemoryRouter>
      <div className={props.surface === "primary" ? "surface-primary" : "surface-secondary"}>
        <IconActions
          actions={[
            { key: "folder", label: "Go to folder", aria: "Go to folder for a.txt", icon: FolderOpen, to: "/files", run: onGo },
            { key: "download", label: "Download", aria: "Download a.txt", icon: Download, href: "/dl/a.txt" },
            { key: "copy", label: "Copy", aria: "Copy a.txt", icon: Copy, run: onCopy },
            { key: "delete", label: "Move to trash", aria: "Move a.txt to trash", icon: Trash2, run: onTrash },
          ]}
          {...props}
        />
      </div>
    </MemoryRouter>,
  );
  return { onCopy, onTrash, onGo };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("IconActions", () => {
  it("renders each action as a labeled ghost icon control for its backdrop", () => {
    renderRow();
    const copy = screen.getByRole("button", { name: "Copy a.txt" });
    expect(copy).toHaveAttribute("data-variant", "ghost");
    expect(copy).toHaveAttribute("data-surface", "secondary");
    expect(copy.className).toMatch(/text-primary/);
    expect(screen.getByRole("link", { name: "Download a.txt" })).toHaveAttribute("href", "/dl/a.txt");
    expect(screen.getByRole("link", { name: "Go to folder for a.txt" })).toHaveAttribute("href", "/files");
    // No popup and no per-button tooltip wrapper until someone reaches for one.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.querySelector('[data-slot="tooltip"]')).toBeNull();
  });

  it("runs the action with a light haptic on click", async () => {
    const user = userEvent.setup();
    const { onCopy, onGo } = renderRow();
    await user.click(screen.getByRole("button", { name: "Copy a.txt" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith("light");
    await user.click(screen.getByRole("link", { name: "Go to folder for a.txt" }));
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it("shares one tooltip: waits on the first icon, then follows the pointer at once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRow();
    await user.hover(screen.getByRole("button", { name: "Copy a.txt" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    await user.hover(screen.getByRole("button", { name: "Move a.txt to trash" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move to trash");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);

    await user.unhover(screen.getByRole("button", { name: "Move a.txt to trash" }));
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("drops a pending open when the pointer leaves during the delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRow();
    await user.hover(screen.getByRole("button", { name: "Copy a.txt" }));
    await user.unhover(screen.getByRole("button", { name: "Copy a.txt" }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the label on keyboard focus and moves with Tab", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Go to folder");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Download");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
  });

  it("re-arms the label after a click while the pointer stays, as Tooltip does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onCopy } = renderRow();
    const copy = screen.getByRole("button", { name: "Copy a.txt" });
    await user.hover(copy);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
    await user.click(copy);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
  });

  it("opens on hover after keyboard focus moved off the hovered button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRow();
    const copy = screen.getByRole("button", { name: "Copy a.txt" });
    const trash = screen.getByRole("button", { name: "Move a.txt to trash" });
    await user.hover(copy);
    copy.focus();
    await user.tab();
    expect(trash).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move to trash");
    // Focus leaves the row; the label goes with it.
    await act(async () => trash.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(trash);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move to trash");
  });

  it("keeps buttons out of the Tab order when asked", () => {
    renderRow({ tabIndex: -1, surface: "primary" });
    const copy = screen.getByRole("button", { name: "Copy a.txt" });
    expect(copy).toHaveAttribute("tabindex", "-1");
    expect(copy).toHaveAttribute("data-surface", "primary");
  });
});
