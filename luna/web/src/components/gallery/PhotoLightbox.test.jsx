import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PhotoLightbox from "./PhotoLightbox.jsx";
import { __resetBodyScrollLockForTests } from "../../utils/bodyScrollLock.js";

const photos = [
  {
    drive_id: "d1",
    path: "one.jpg",
    name: "one.jpg",
    kind: "image",
  },
  {
    drive_id: "d1",
    path: "two.jpg",
    name: "two.jpg",
    kind: "image",
  },
];

afterEach(() => {
  __resetBodyScrollLockForTests();
});

function renderLightbox(props = {}) {
  return render(
    <MemoryRouter>
      <PhotoLightbox
        photos={photos}
        index={0}
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("PhotoLightbox scroll lock", () => {
  it("locks document scroll while open and restores on unmount", () => {
    const { unmount } = renderLightbox();

    expect(screen.getByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    unmount();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("keeps page scroll locked if body.style.overflow is cleared (ModalCard pattern)", () => {
    renderLightbox();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    // ModalCard clears inline overflow when its overlay stack empties.
    document.body.style.overflow = "hidden";
    document.body.style.overflow = "";

    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    expect(screen.getByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
  });

  it("still navigates photos with arrow keys while scroll is locked", () => {
    const onIndexChange = vi.fn();
    renderLightbox({ onIndexChange });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });
});

describe("PhotoLightbox guest mode", () => {
  it("hides favorite, album, share, trash, and folder actions", () => {
    renderLightbox({ mode: "guest" });
    expect(screen.queryByLabelText(/Favorite/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Add to album/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Share link/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Move to trash/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Open folder/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/i })).toBeInTheDocument();
  });

  it("keeps download available for guests", () => {
    renderLightbox({ mode: "guest", downloadSrc: "/public/dl" });
    const link = screen.getByRole("link", { name: /Download/i });
    expect(link).toHaveAttribute("href", "/public/dl");
  });
});
