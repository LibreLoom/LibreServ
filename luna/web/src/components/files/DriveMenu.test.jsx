import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import DriveMenu, { DRIVE_MENU_OPEN_MS } from "./DriveMenu.jsx";
import { LUNA_DRIVE_MIME, LUNA_PATHS_MIME, SPRING_LOAD_MS } from "../../lib/dnd.js";

const DRIVES = [
  { id: "d1", label: "Photos Drive", state: "as_is" },
  { id: "d2", label: "Spare Drive", state: "as_is" },
  { id: "d3", label: "Backup Drive", state: "as_is" },
];

function lunaDrag(paths = ["a.txt"], sourceDrive = "d1") {
  return {
    types: [LUNA_PATHS_MIME],
    dropEffect: "",
    getData: (type) =>
      type === LUNA_PATHS_MIME ? JSON.stringify(paths)
      : type === LUNA_DRIVE_MIME ? sourceDrive
      : "",
  };
}

/** @param {{ drives?: any[], onDropPaths?: (driveId: string, paths: string[], sourceDriveId?: string) => void }} props */
function Harness({ drives = DRIVES, onDropPaths = vi.fn() }) {
  const { id } = useParams();
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <DriveMenu drives={drives} currentDriveId={id} onDropPaths={onDropPaths} />
    </>
  );
}

/** @param {{ drives?: any[], onDropPaths?: (driveId: string, paths: string[], sourceDriveId?: string) => void }} [opts] */
function renderMenu({ drives, onDropPaths } = {}) {
  return render(
    <MemoryRouter initialEntries={["/drives/d1"]}>
      <Routes>
        <Route
          path="/drives/:id"
          element={<Harness drives={drives} onDropPaths={onDropPaths} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DriveMenu", () => {
  it("renders nothing when fewer than two drives are ready", () => {
    render(
      <MemoryRouter>
        <DriveMenu
          drives={[DRIVES[0], { id: "d9", label: "Unplugged", state: "missing" }]}
          currentDriveId="d1"
          onDropPaths={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: /Drives/ })).not.toBeInTheDocument();
  });

  it("lists the other drives and navigates to a picked drive's root", async () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Drives: Photos Drive" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Drives" });
    // The drive being browsed is on the trigger, not in the list.
    expect(within(menu).queryByRole("menuitem", { name: "Photos Drive" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Spare Drive" }));
    expect(screen.getByTestId("location").textContent).toBe("/drives/d2");
  });

  it("dropping on a drive item moves files to its root without navigating", async () => {
    const onDropPaths = vi.fn();
    renderMenu({ onDropPaths });
    fireEvent.click(screen.getByRole("button", { name: "Drives: Photos Drive" }));
    const item = await screen.findByRole("menuitem", { name: "Spare Drive" });
    const dataTransfer = lunaDrag(["docs/a.txt"]);
    fireEvent.dragOver(item, { dataTransfer });
    expect(item.className).toMatch(/ring-accent/);
    fireEvent.drop(item, { dataTransfer });
    expect(onDropPaths).toHaveBeenCalledWith("d2", ["docs/a.txt"], "d1");
    expect(screen.getByTestId("location").textContent).toBe("/drives/d1");
  });

  it("does not accept a drop on a read-only drive", async () => {
    const onDropPaths = vi.fn();
    renderMenu({
      drives: [DRIVES[0], { id: "d4", label: "Read Only", state: "readonly" }],
      onDropPaths,
    });
    fireEvent.click(screen.getByRole("button", { name: "Drives: Photos Drive" }));
    const item = await screen.findByRole("menuitem", { name: "Read Only" });
    const dataTransfer = lunaDrag();
    fireEvent.dragOver(item, { dataTransfer });
    expect(item.className).not.toMatch(/ring-accent/);
    fireEvent.drop(item, { dataTransfer });
    expect(onDropPaths).not.toHaveBeenCalled();
  });

  it("auto-opens when a file drag hovers the trigger", async () => {
    vi.useFakeTimers();
    try {
      renderMenu();
      const trigger = screen.getByRole("button", { name: "Drives: Photos Drive" });
      const dataTransfer = lunaDrag();
      fireEvent.dragOver(trigger, { dataTransfer });
      // A quick pass does not open it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIVE_MENU_OPEN_MS - 100);
      });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.getByRole("menu", { name: "Drives" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores drag hovers that are not file drags", async () => {
    vi.useFakeTimers();
    try {
      renderMenu();
      const trigger = screen.getByRole("button", { name: "Drives: Photos Drive" });
      fireEvent.dragOver(trigger, { dataTransfer: { types: ["text/plain"] } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIVE_MENU_OPEN_MS + 200);
      });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("spring-loads a drive item held under a drag, keeping the drag alive", async () => {
    vi.useFakeTimers();
    try {
      renderMenu();
      fireEvent.click(screen.getByRole("button", { name: "Drives: Photos Drive" }));
      const item = screen.getByRole("menuitem", { name: "Spare Drive" });
      fireEvent.dragOver(item, { dataTransfer: lunaDrag() });
      expect(screen.getByTestId("location").textContent).toBe("/drives/d1");
      // Hold past the spring-load delay — the browser navigates to the
      // drive's root so the in-flight drag can drop into a folder there.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPRING_LOAD_MS);
      });
      expect(screen.getByTestId("location").textContent).toBe("/drives/d2");
      // The menu closes after spring-loading.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spring-load when the drag leaves the item before the delay", async () => {
    vi.useFakeTimers();
    try {
      renderMenu();
      fireEvent.click(screen.getByRole("button", { name: "Drives: Photos Drive" }));
      const item = screen.getByRole("menuitem", { name: "Spare Drive" });
      const dataTransfer = lunaDrag();
      fireEvent.dragOver(item, { dataTransfer });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPRING_LOAD_MS - 300);
      });
      fireEvent.dragLeave(item, { dataTransfer, relatedTarget: document.body });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPRING_LOAD_MS + 300);
      });
      expect(screen.getByTestId("location").textContent).toBe("/drives/d1");
    } finally {
      vi.useRealTimers();
    }
  });
});
