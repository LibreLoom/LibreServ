import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddToAlbumModal from "./AddToAlbumModal.jsx";

const ALBUMS = [
  { id: "a1", home_drive_id: "d1", name: "Vacation", item_count: 3, shared: false },
  { id: "a2", home_drive_id: "d1", name: "Family", item_count: 1, shared: true },
  { id: "a3", home_drive_id: "d2", name: "test", item_count: 0, shared: false },
];

const PHOTOS = [{ drive_id: "d1", path: "one.jpg" }];

/**
 * Stub album membership: `membership` maps album id -> item refs the album
 * already holds. Everything else returns an empty list.
 * @param {Record<string, Array<{drive_id: string, path: string}>>} membership
 */
function stubItemsFetch(membership = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      const match = u.match(/\/api\/v1\/gallery\/albums\/[^/]+\/([^/]+)\/items/);
      const items = match ? membership[match[1]] || [] : [];
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("AddToAlbumModal", () => {
  beforeEach(() => {
    stubItemsFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Apply until an album is toggled", async () => {
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Vacation/i }));
    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeEnabled();
  });

  it("filters the album list by search", async () => {
    const user = userEvent.setup();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText(/Search albums/i), "fam");
    expect(screen.getByRole("checkbox", { name: /Family/i })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Vacation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^test/i })).not.toBeInTheDocument();
  });

  it("checks albums that already hold every selected photo", async () => {
    stubItemsFetch({ a1: [{ drive_id: "d1", path: "one.jpg" }] });
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /Vacation/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    expect(screen.getByRole("checkbox", { name: /Family/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("marks an album mixed when only some selected photos are inside", async () => {
    stubItemsFetch({ a1: [{ drive_id: "d1", path: "one.jpg" }] });
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={[...PHOTOS, { drive_id: "d1", path: "two.jpg" }]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /Vacation/i })).toHaveAttribute(
        "aria-checked",
        "mixed",
      );
    });
  });

  it("calls onApply with add changes for checked albums", async () => {
    const onApply = vi.fn();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: /test/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [changes, close] = onApply.mock.calls[0];
    expect(changes).toEqual([
      {
        album: expect.objectContaining({ id: "a3", name: "test" }),
        add: [{ drive_id: "d1", path: "one.jpg" }],
      },
    ]);
    expect(typeof close).toBe("function");
  });

  it("calls onApply with remove changes when a member album is unchecked", async () => {
    stubItemsFetch({ a1: [{ drive_id: "d1", path: "one.jpg" }] });
    const onApply = vi.fn();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    const vacation = await screen.findByRole("checkbox", { name: /Vacation/i });
    await waitFor(() => expect(vacation).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(vacation);
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));

    const [changes] = onApply.mock.calls[0];
    expect(changes).toEqual([
      {
        album: expect.objectContaining({ id: "a1" }),
        remove: [{ drive_id: "d1", path: "one.jpg" }],
      },
    ]);
  });

  it("shows empty-album copy and keeps Apply disabled when there are no albums", () => {
    render(
      <AddToAlbumModal
        open
        albums={[]}
        photos={PHOTOS}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Create an album first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeDisabled();
  });

  it("shows loading state on Apply while applying", () => {
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        applying
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const applyBtn = screen.getByRole("button", { name: /Apply/i });
    expect(applyBtn).toHaveAttribute("aria-busy", "true");
    expect(applyBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeDisabled();
  });

  it("Cancel dismisses via ModalCard close", async () => {
    const onClose = vi.fn();
    render(
      <AddToAlbumModal
        open
        albums={ALBUMS}
        photos={PHOTOS}
        onApply={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
