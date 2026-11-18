import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FileSearchRow from "./FileSearchRow.jsx";

/** @type {import("../../lib/fileSearch.js").SearchHit} */
const item = {
  drive_id: "d1", path: "a/beach.jpg", parent: "a", name: "beach.jpg", kind: "file", size: 1, modified: 1, match: "name",
};

/** @param {Partial<Record<string, any>>} props */
function renderRow(props = {}) {
  const all = {
    item,
    query: "beach",
    driveLabel: "Photos Drive",
    isAdmin: true,
    memberAccess: undefined,
    index: 0,
    isSmUp: true,
    iconColor: "#123456",
    actionsLive: false,
    onNavigate: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    onTrash: vi.fn(),
    ...props,
  };
  const view = render(
    <MemoryRouter>
      <ul>
        <FileSearchRow {...all} />
      </ul>
    </MemoryRouter>,
  );
  return {
    ...view,
    /** @param {Partial<Record<string, any>>} next */
    update: (next) => view.rerender(
      <MemoryRouter>
        <ul>
          <FileSearchRow {...all} {...next} />
        </ul>
      </MemoryRouter>,
    ),
  };
}

const picture = () => document.querySelector("[data-slot=file-search-actions-picture]");
const shareButton = () => screen.queryByRole("button", { name: "Sharing for beach.jpg" });

describe("FileSearchRow", () => {
  it("first paints its action icons as one hidden picture, then mounts the buttons", () => {
    const { update } = renderRow();
    expect(picture()).toHaveAttribute("aria-hidden", "true");
    expect(shareButton()).toBeNull();
    update({ actionsLive: true });
    expect(picture()).toBeNull();
    expect(shareButton()).toBeInTheDocument();
    // Once mounted, the buttons stay even if a new answer starts pacing again.
    update({ actionsLive: false });
    expect(shareButton()).toBeInTheDocument();
  });

  it("mounts the buttons at once when the row gets keyboard focus", () => {
    renderRow();
    const link = screen.getByRole("link", { name: "Open beach.jpg" });
    act(() => link.focus());
    expect(link).toHaveFocus();
    expect(picture()).toBeNull();
    expect(screen.getByRole("link", { name: "Go to folder for beach.jpg" })).toHaveAttribute("tabindex", "-1");
  });

  it("mounts the buttons when a mouse reaches the row", () => {
    renderRow();
    fireEvent.pointerOver(screen.getByRole("link", { name: "Open beach.jpg" }), { pointerType: "mouse" });
    expect(shareButton()).toBeInTheDocument();
  });

  it("passes a tap on the picture to the button at that spot", () => {
    const onShare = vi.fn();
    renderRow({ onShare });
    // Go to folder, Download, Share: 26 px buttons 4 px apart.
    fireEvent.click(/** @type {Element} */ (picture()), { clientX: 2 * 30 + 13 });
    expect(shareButton()).toBeInTheDocument();
    expect(onShare).toHaveBeenCalledWith(item);
  });

  it("drops a tap in the gap between two icons, as between two buttons", () => {
    const onShare = vi.fn();
    const onNavigate = vi.fn();
    renderRow({ onShare, onNavigate });
    fireEvent.click(/** @type {Element} */ (picture()), { clientX: 2 * 30 - 2 });
    expect(shareButton()).toBeInTheDocument();
    expect(onShare).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("mounts the buttons right away when the icons can't be drawn as an image", () => {
    renderRow({ iconColor: null });
    expect(picture()).toBeNull();
    expect(shareButton()).toBeInTheDocument();
  });

  it("keeps the phone menu as it is", () => {
    renderRow({ isSmUp: false });
    expect(picture()).toBeNull();
    expect(screen.getByRole("button", { name: /beach\.jpg/ })).toBeInTheDocument();
  });

  it("underlines the typed words in the name", () => {
    renderRow({ query: "bea" });
    const name = screen.getByText("bea");
    expect(name).toHaveClass("underline");
    expect(name.parentElement).toHaveTextContent("beach.jpg");
  });
});
