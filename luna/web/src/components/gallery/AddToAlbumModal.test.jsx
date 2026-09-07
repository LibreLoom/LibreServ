import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddToAlbumModal from "./AddToAlbumModal.jsx";

const ALBUMS = [
  { id: "a1", home_drive_id: "d1", name: "Vacation", item_count: 3, shared: false },
  { id: "a2", home_drive_id: "d1", name: "Family", item_count: 1, shared: true },
  { id: "a3", home_drive_id: "d2", name: "test", item_count: 0, shared: false },
];

describe("AddToAlbumModal", () => {
  it("disables Add until an album is selected", () => {
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /^Add$/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: /Vacation/i }));
    expect(screen.getByRole("button", { name: /^Add$/i })).toBeEnabled();
  });

  it("filters the album list by search", async () => {
    const user = userEvent.setup();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText(/Search albums/i), "fam");
    expect(screen.getByRole("option", { name: /Family/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Vacation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^test/i })).not.toBeInTheDocument();
  });

  it("calls onAdd with the selected album and a close callback", () => {
    const onAdd = vi.fn();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        onAdd={onAdd}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /test/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toMatchObject({ id: "a3", name: "test" });
    expect(typeof onAdd.mock.calls[0][1]).toBe("function");
  });

  it("shows empty-album copy and keeps Add disabled when there are no albums", () => {
    render(
      <AddToAlbumModal
        open
        albums={[]}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Create an album first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add$/i })).toBeDisabled();
  });

  it("shows loading state on Add while adding", () => {
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        adding
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const addBtn = screen.getByRole("button", { name: /Add/i });
    expect(addBtn).toHaveAttribute("aria-busy", "true");
    expect(addBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeDisabled();
  });

  it("Cancel dismisses via ModalCard close", async () => {
    const onClose = vi.fn();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        onAdd={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
