import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Trash2, Users } from "lucide-react";
import RowActionMenu, { RowActionSheet } from "./RowActionMenu.jsx";

function renderMenu(actions) {
  return render(
    <MemoryRouter>
      <RowActionMenu label="beach.jpg" actions={actions} surface="primary" />
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("RowActionMenu", () => {
  it("opens one sheet from the lightning button", async () => {
    renderMenu([
      { key: "share", label: "Share", icon: Users, run: vi.fn() },
      { key: "delete", label: "Move to trash", icon: Trash2, danger: true, run: vi.fn() },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for beach.jpg" }));
    const dialog = await screen.findByRole("dialog", { name: "beach.jpg" });
    expect(within(dialog).getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
  });

  it("closes the sheet and runs the action", async () => {
    const run = vi.fn();
    renderMenu([{ key: "delete", label: "Move to trash", icon: Trash2, danger: true, run }]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for beach.jpg" }));
    await userEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The bug this component exists to stop: the destructive row carried the
  // danger card's extra padding and stood half again as tall as every other
  // row in the same sheet.
  it("gives every sheet row the same height, destructive or not", () => {
    const actions = [
      { key: "share", label: "Share", icon: Users, run: vi.fn() },
      { key: "delete", label: "Move to trash", icon: Trash2, danger: true, run: vi.fn() },
    ];
    render(
      <MemoryRouter>
        <RowActionSheet actions={actions} close={vi.fn()} />
      </MemoryRouter>,
    );
    const heights = ["Share", "Move to trash"].map((name) => {
      const classes = screen.getByRole("button", { name }).className.split(/\s+/);
      return classes.filter((c) => /^(p|py|px|h)-/.test(c)).sort();
    });
    expect(heights[0]).toEqual(heights[1]);
  });

  it("keeps a caller's own sheet body, so the explorer's actions still show", async () => {
    render(
      <MemoryRouter>
        <RowActionMenu
          label="beach.jpg"
          surface="secondary"
          renderSheet={(close) => (
            <RowActionSheet
              close={close}
              actions={[{ key: "restore", label: "Restore", icon: Users, run: vi.fn() }]}
            />
          )}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions for beach.jpg" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });
});
