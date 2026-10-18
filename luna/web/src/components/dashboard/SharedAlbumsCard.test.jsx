import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import SharedAlbumsCard from "./SharedAlbumsCard.jsx";

/** `count` albums on one drive, the way memberAccessRoots hands them over. */
function albums(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `album:d1:al${i + 1}`,
    name: `Album ${i + 1}`,
    kind: "album",
    drive_id: "d1",
    album_id: `al${i + 1}`,
  }));
}

function renderCard(props = {}) {
  return render(
    <MemoryRouter>
      <SharedAlbumsCard albums={[]} {...props} />
    </MemoryRouter>,
  );
}

describe("SharedAlbumsCard", () => {
  describe("empty", () => {
    it("renders nothing for an empty list", () => {
      const { container } = renderCard({ albums: [] });
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText("Albums shared with you")).not.toBeInTheDocument();
    });

    it("renders nothing when albums are missing", () => {
      const { container } = renderCard({ albums: undefined });
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when albums are null", () => {
      const { container } = renderCard({ albums: null });
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("one album", () => {
    it("shows the card title, the album name and a link that opens it", () => {
      renderCard({
        albums: [{ id: "a1", name: "Summer trip", kind: "album", drive_id: "d1", album_id: "al1" }],
      });

      expect(screen.getByText("Albums shared with you")).toBeInTheDocument();
      expect(screen.getByText("Summer trip")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View album" })).toHaveAttribute("href", "/gallery#albums/d1/al1");
      expect(screen.queryByRole("link", { name: "See all albums" })).not.toBeInTheDocument();
    });

    it("encodes ids that need it in the album link", () => {
      renderCard({
        albums: [{ id: "a1", name: "Odd ids", kind: "album", drive_id: "d 1", album_id: "al/1" }],
      });

      expect(screen.getByRole("link", { name: "View album" })).toHaveAttribute(
        "href",
        "/gallery#albums/d%201/al%2F1",
      );
    });
  });

  describe("up to the limit", () => {
    it("lists all eight albums with no See all link", () => {
      renderCard({ albums: albums(8) });

      const list = screen.getByRole("list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(8);
      expect(screen.getByText("Album 8")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "View album" })).toHaveLength(8);
      expect(screen.queryByRole("link", { name: "See all albums" })).not.toBeInTheDocument();
    });
  });

  describe("over the limit", () => {
    it("lists only the first eight and links to every album", () => {
      renderCard({ albums: albums(9) });

      const list = screen.getByRole("list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(8);
      expect(screen.getByText("Album 1")).toBeInTheDocument();
      expect(screen.getByText("Album 8")).toBeInTheDocument();
      expect(screen.queryByText("Album 9")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "See all albums" })).toHaveAttribute("href", "/gallery#albums");
    });

    it("keeps the first eight in order for a long list", () => {
      renderCard({ albums: albums(20) });

      const rows = within(screen.getByRole("list")).getAllByRole("listitem");
      expect(rows).toHaveLength(8);
      expect(within(rows[0]).getByText("Album 1")).toBeInTheDocument();
      expect(within(rows[7]).getByText("Album 8")).toBeInTheDocument();
      expect(screen.queryByText("Album 20")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "See all albums" })).toBeInTheDocument();
    });
  });
});
