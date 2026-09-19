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

describe("PhotoLightbox fullscreen animations", () => {
  it("applies the unified fullscreen enter animation on open", () => {
    renderLightbox();
    const dialog = screen.getByRole("dialog", { name: "one.jpg" });
    expect(dialog).toHaveClass("fullscreen-overlay-enter");
    expect(dialog).toHaveClass("file-viewer-enter");
  });

  it("animates out with fullscreen exit class and invokes onClose after 250ms on Close click", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      renderLightbox({ onClose });

      const dialog = screen.getByRole("dialog", { name: "one.jpg" });
      expect(dialog).toHaveClass("fullscreen-overlay-enter");

      fireEvent.click(screen.getByLabelText("Close"));

      expect(dialog).toHaveClass("fullscreen-overlay-exit");
      expect(dialog).toHaveClass("file-viewer-exit");
      expect(onClose).not.toHaveBeenCalled();

      // Scroll lock must remain held while exit animation is playing
      expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

      vi.advanceTimersByTime(250);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates out with fullscreen exit class and invokes onClose after 250ms on Escape", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      renderLightbox({ onClose });

      const dialog = screen.getByRole("dialog", { name: "one.jpg" });
      expect(dialog).toHaveClass("fullscreen-overlay-enter");

      fireEvent.keyDown(window, { key: "Escape" });

      expect(dialog).toHaveClass("fullscreen-overlay-exit");
      expect(onClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates out when open prop switches to false", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { rerender } = render(
        <MemoryRouter>
          <PhotoLightbox
            photos={photos}
            index={0}
            open={true}
            onClose={onClose}
            onIndexChange={vi.fn()}
          />
        </MemoryRouter>,
      );

      const dialog = screen.getByRole("dialog", { name: "one.jpg" });
      expect(dialog).toHaveClass("fullscreen-overlay-enter");

      rerender(
        <MemoryRouter>
          <PhotoLightbox
            photos={photos}
            index={0}
            open={false}
            onClose={onClose}
            onIndexChange={vi.fn()}
          />
        </MemoryRouter>,
      );

      expect(dialog).toHaveClass("fullscreen-overlay-exit");
      expect(onClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
