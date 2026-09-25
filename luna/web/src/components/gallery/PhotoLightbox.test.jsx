import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

describe("PhotoLightbox swipe navigation", () => {
  function stage() {
    return document.querySelector('[data-slot="photo-lightbox-stage"]');
  }

  function swipe(el, from, to) {
    fireEvent.touchStart(el, { changedTouches: [{ clientX: from, clientY: 200 }] });
    fireEvent.touchMove(el, { changedTouches: [{ clientX: (from + to) / 2, clientY: 200 }] });
    fireEvent.touchMove(el, { changedTouches: [{ clientX: to, clientY: 200 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: to, clientY: 200 }] });
  }

  // Same gesture with the fake clock ticking between moves, so the velocity
  // tracker sees a real fling.
  function flick(el, from, to) {
    fireEvent.touchStart(el, { changedTouches: [{ clientX: from, clientY: 200 }] });
    act(() => { vi.advanceTimersByTime(30); });
    fireEvent.touchMove(el, { changedTouches: [{ clientX: (from + to) / 2, clientY: 200 }] });
    act(() => { vi.advanceTimersByTime(30); });
    fireEvent.touchMove(el, { changedTouches: [{ clientX: to, clientY: 200 }] });
    act(() => { vi.advanceTimersByTime(20); });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: to, clientY: 200 }] });
  }

  it("advances to the next photo on a committed left swipe", () => {
    vi.useFakeTimers();
    try {
      const onIndexChange = vi.fn();
      renderLightbox({ onIndexChange });
      swipe(stage(), 700, 100);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(onIndexChange).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back on a committed right swipe", () => {
    vi.useFakeTimers();
    try {
      const onIndexChange = vi.fn();
      renderLightbox({ index: 1, onIndexChange });
      swipe(stage(), 100, 700);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(onIndexChange).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("snaps back without navigating on a short swipe", () => {
    vi.useFakeTimers();
    try {
      const onIndexChange = vi.fn();
      renderLightbox({ onIndexChange });
      swipe(stage(), 300, 250);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(onIndexChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not navigate past the last photo", () => {
    vi.useFakeTimers();
    try {
      const onIndexChange = vi.fn();
      renderLightbox({ index: 1, onIndexChange });
      swipe(stage(), 500, 100);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(onIndexChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits at release and never re-centers the previous pane", () => {
    vi.useFakeTimers();
    try {
      const four = [
        ...photos,
        { drive_id: "d1", path: "three.jpg", name: "three.jpg", kind: "image" },
        { drive_id: "d1", path: "four.jpg", name: "four.jpg", kind: "image" },
      ];
      let domAtEmit = null;
      let firstPaneAtEmit = null;
      function Harness() {
        const [idx, setIdx] = useState(1);
        return (
          <MemoryRouter>
            <PhotoLightbox
              photos={four}
              index={idx}
              onClose={vi.fn()}
              onIndexChange={(i) => {
                const trackEl = /** @type {HTMLElement} */ (
                  stage().querySelector('[data-slot="photo-lightbox-track"]')
                );
                // The commit fires at release, mid-flight: the DOM still holds
                // the drag position under the pre-shift pane window.
                domAtEmit = trackEl.style.transform;
                firstPaneAtEmit = trackEl.querySelector("img")?.getAttribute("src");
                setIdx(i);
              }}
            />
          </MemoryRouter>
        );
      }
      render(<Harness />);
      const trackEl = /** @type {HTMLElement} */ (
        stage().querySelector('[data-slot="photo-lightbox-track"]')
      );
      const step = (trackEl.clientWidth || window.innerWidth || 1) + 12;

      swipe(stage(), 700, 100);
      // Emit happens synchronously at touchend — the DOM shows the release
      // position (px), and the pane window has not shifted yet.
      expect(domAtEmit).toMatch(/^translateX\(-?\d+(\.\d+)?px\)$/);
      expect(firstPaneAtEmit).toContain("one.jpg");

      act(() => { vi.advanceTimersByTime(1500); });
      // Landed on pane 2: window re-anchored to [1,2,3], so -step centers it.
      expect(trackEl.style.transform).toBe(`translateX(${-step}px)`);
      expect(trackEl.querySelector("img")?.getAttribute("src")).toContain("two.jpg");
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances once per swipe — chained mid-spring swipes stack", () => {
    vi.useFakeTimers();
    try {
      const four = [
        ...photos,
        { drive_id: "d1", path: "three.jpg", name: "three.jpg", kind: "image" },
        { drive_id: "d1", path: "four.jpg", name: "four.jpg", kind: "image" },
      ];
      const onIndexChange = vi.fn();
      function Harness() {
        const [idx, setIdx] = useState(0);
        return (
          <MemoryRouter>
            <PhotoLightbox
              photos={four}
              index={idx}
              onClose={vi.fn()}
              onIndexChange={(i) => {
                onIndexChange(i);
                setIdx(i);
              }}
            />
          </MemoryRouter>
        );
      }
      render(<Harness />);

      // First swipe commits to 1; a second swipe mid-spring must chain onto
      // the pending destination — not fall back to the stale anchor.
      swipe(stage(), 700, 100);
      expect(onIndexChange).toHaveBeenLastCalledWith(1);
      act(() => { vi.advanceTimersByTime(120); });
      flick(stage(), 800, 100);
      act(() => { vi.advanceTimersByTime(1500); });

      expect(onIndexChange).toHaveBeenLastCalledWith(2);
      const trackEl = /** @type {HTMLElement} */ (
        stage().querySelector('[data-slot="photo-lightbox-track"]')
      );
      const step = (trackEl.clientWidth || window.innerWidth || 1) + 12;
      expect(trackEl.style.transform).toBe(`translateX(${-step}px)`);
      expect(screen.getByRole("dialog", { name: "three.jpg" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a long drag slides through multiple panes — no wall", () => {
    vi.useFakeTimers();
    try {
      const four = [
        ...photos,
        { drive_id: "d1", path: "three.jpg", name: "three.jpg", kind: "image" },
        { drive_id: "d1", path: "four.jpg", name: "four.jpg", kind: "image" },
      ];
      const onIndexChange = vi.fn();
      function Harness() {
        const [idx, setIdx] = useState(0);
        return (
          <MemoryRouter>
            <PhotoLightbox
              photos={four}
              index={idx}
              onClose={vi.fn()}
              onIndexChange={(i) => {
                onIndexChange(i);
                setIdx(i);
              }}
            />
          </MemoryRouter>
        );
      }
      render(<Harness />);
      const trackEl = /** @type {HTMLElement} */ (
        stage().querySelector('[data-slot="photo-lightbox-track"]')
      );

      // ~2.8 pane-widths — the window grows under the finger instead of
      // dead-stopping at the first neighbor like the old mounted-edge clamp.
      swipe(stage(), 3000, 100);
      expect(onIndexChange).toHaveBeenLastCalledWith(3);
      // All four panes mounted (the window grew) — but transit panes are
      // thumbnail-only: no full-res img for the destination until it holds.
      expect(trackEl.children.length).toBe(4);
      expect(trackEl.querySelector('img[alt="four.jpg"]')).toBeNull();

      act(() => { vi.advanceTimersByTime(1500); });
      // Landed and primed: the destination upgrades to full-res.
      expect(trackEl.querySelector('img[alt="four.jpg"]')).not.toBeNull();
      const step = (trackEl.clientWidth || window.innerWidth || 1) + 12;
      expect(trackEl.style.transform).toBe(`translateX(${-step}px)`);
      expect(screen.getByRole("dialog", { name: "four.jpg" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a backward chained swipe shifts the window without teleporting the track", () => {
    vi.useFakeTimers();
    try {
      const four = [
        ...photos,
        { drive_id: "d1", path: "three.jpg", name: "three.jpg", kind: "image" },
        { drive_id: "d1", path: "four.jpg", name: "four.jpg", kind: "image" },
      ];
      const transforms = /** @type {string[]} */ ([]);
      function Harness() {
        const [idx, setIdx] = useState(2);
        return (
          <MemoryRouter>
            <PhotoLightbox
              photos={four}
              index={idx}
              onClose={vi.fn()}
              onIndexChange={(i) => {
                transforms.push(trackTransform());
                setIdx(i);
              }}
            />
          </MemoryRouter>
        );
      }
      function trackTransform() {
        const el = /** @type {HTMLElement} */ (
          stage().querySelector('[data-slot="photo-lightbox-track"]')
        );
        return el.style.transform;
      }
      render(<Harness />);
      const trackEl = /** @type {HTMLElement} */ (
        stage().querySelector('[data-slot="photo-lightbox-track"]')
      );
      const step = (trackEl.clientWidth || window.innerWidth || 1) + 12;

      // Swipe right (back) past the anchor: the commit render prepends pane 0,
      // shifting every pane's DOM-x — the compensation effect must keep the
      // track's translate continuous, never jumping to a calc() prop write.
      swipe(stage(), 100, 900);
      expect(transforms.length).toBeGreaterThan(0);
      for (const t of transforms) {
        expect(t).toMatch(/^translateX\(-?\d+(\.\d+)?px\)$/);
        expect(t).not.toContain("calc");
      }
      act(() => { vi.advanceTimersByTime(1500); });
      // Landed on pane 1: window [0,2], translate = -step centers it.
      expect(trackEl.style.transform).toBe(`translateX(${-step}px)`);
      expect(screen.getByRole("dialog", { name: "two.jpg" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rapid Next clicks chain — each click advances without waiting for the spring", () => {
    vi.useFakeTimers();
    try {
      const four = [
        ...photos,
        { drive_id: "d1", path: "three.jpg", name: "three.jpg", kind: "image" },
        { drive_id: "d1", path: "four.jpg", name: "four.jpg", kind: "image" },
      ];
      const onIndexChange = vi.fn();
      function Harness() {
        const [idx, setIdx] = useState(0);
        return (
          <MemoryRouter>
            <PhotoLightbox
              photos={four}
              index={idx}
              onClose={vi.fn()}
              onIndexChange={(i) => {
                onIndexChange(i);
                setIdx(i);
              }}
            />
          </MemoryRouter>
        );
      }
      render(<Harness />);

      const next = () => screen.getByRole("button", { name: "Next" });
      fireEvent.click(next());
      expect(onIndexChange).toHaveBeenLastCalledWith(1);
      // Second click lands mid-spring — it must retarget, not queue.
      act(() => { vi.advanceTimersByTime(60); });
      fireEvent.click(next());
      expect(onIndexChange).toHaveBeenLastCalledWith(2);
      act(() => { vi.advanceTimersByTime(60); });
      fireEvent.click(next());
      expect(onIndexChange).toHaveBeenLastCalledWith(3);

      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole("dialog", { name: "four.jpg" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("springs the track and re-anchors on the new photo when index changes", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <MemoryRouter>
          <PhotoLightbox photos={photos} index={0} onClose={vi.fn()} onIndexChange={vi.fn()} />
        </MemoryRouter>,
      );
      const trackEl = /** @type {HTMLElement} */ (
        stage().querySelector('[data-slot="photo-lightbox-track"]')
      );

      rerender(
        <MemoryRouter>
          <PhotoLightbox photos={photos} index={1} onClose={vi.fn()} onIndexChange={vi.fn()} />
        </MemoryRouter>,
      );

      // Spring in flight: rAF writes a live px offset toward the next pane.
      act(() => { vi.advanceTimersByTime(80); });
      expect(trackEl.style.transform).toMatch(/-\d+(\.\d+)?px/);

      act(() => { vi.advanceTimersByTime(1500); });
      // Settled: re-anchored so pane 1 sits centered — one full slide step back.
      const step = (trackEl.clientWidth || window.innerWidth || 1) + 12;
      expect(trackEl.style.transform).toBe(`translateX(${-step}px)`);
    } finally {
      vi.useRealTimers();
    }
  });
});
