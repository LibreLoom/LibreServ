import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import PhotoThumb from "./PhotoThumb.jsx";

const photo = { name: "print.jpg", kind: "image" };

function renderThumb() {
  const onOpen = vi.fn();
  const view = render(<PhotoThumb photo={photo} onOpen={onOpen} />);
  const button = view.getByRole("button", { name: "print.jpg" });
  return { button, onOpen };
}

describe("PhotoThumb focus", () => {
  it("drops focus when a photo is opened with a click", () => {
    const { button, onOpen } = renderThumb();
    button.focus();
    fireEvent.click(button, { detail: 1 });
    expect(onOpen).toHaveBeenCalledWith(photo);
    expect(document.activeElement).not.toBe(button);
  });

  it("keeps focus when a photo is opened from the keyboard", () => {
    const { button, onOpen } = renderThumb();
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(onOpen).toHaveBeenCalledWith(photo);
    expect(document.activeElement).toBe(button);
  });

  it("uses a single keyboard ring", () => {
    const { button } = renderThumb();
    expect(button.className).toMatch(/\bno-focus-outline\b/);
    expect(button.className).toMatch(/focus-visible:ring-2/);
  });
});

describe("PhotoThumb private", () => {
  it("shows a lock on a private photo and names it in the button", () => {
    const view = render(<PhotoThumb photo={{ name: "id.jpg", kind: "image", private: true }} />);
    expect(view.getByRole("button", { name: "id.jpg, private" })).toBeInTheDocument();
    expect(view.getByLabelText("Private")).toBeInTheDocument();
  });

  it("shows no lock on an ordinary photo", () => {
    const view = render(<PhotoThumb photo={photo} />);
    expect(view.queryByLabelText("Private")).toBeNull();
  });
});

describe("PhotoThumb loading", () => {
  const thumb = "/api/v1/photos/thumb?drive_id=d1&path=a.jpg";

  it("offers the grid-sized lunad thumbnail through srcset", () => {
    const view = render(<PhotoThumb photo={{ ...photo, thumb }} sizes="17vw" />);
    const img = view.container.querySelector("img");
    expect(img.getAttribute("src")).toBe(thumb);
    expect(img.getAttribute("srcset")).toBe(`${thumb}&size=s 270w, ${thumb} 480w`);
    expect(img.getAttribute("sizes")).toBe("17vw");
  });

  it("leaves other thumbnails as they are", () => {
    const view = render(<PhotoThumb photo={{ ...photo, thumb: "data:image/png;base64,AA" }} sizes="17vw" />);
    const img = view.container.querySelector("img");
    expect(img.hasAttribute("srcset")).toBe(false);
  });
});

describe("PhotoThumb waits until it nears the screen", () => {
  const thumb = "/api/v1/photos/thumb?drive_id=d1&path=a.jpg";

  it("asks for the thumbnail only once the cell is near the screen", async () => {
    /** @type {((entries: any[]) => void) | null} */
    let notify = null;
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb, opts) {
          // The near tier (a px margin), not the ahead one.
          if (opts?.rootMargin?.endsWith("px 0px")) notify = cb;
        }
        observe = observe;
        unobserve() {}
        disconnect() {}
      },
    );
    vi.resetModules();
    try {
      const { default: FreshThumb } = await import("./PhotoThumb.jsx");
      const view = render(<FreshThumb photo={{ ...photo, thumb }} sizes="17vw" />);
      const img = view.container.querySelector("img");
      expect(img.hasAttribute("src")).toBe(false);
      expect(img.hasAttribute("data-thumb-pending")).toBe(true);
      expect(observe).toHaveBeenCalledWith(img);

      act(() => notify?.([{ target: img, isIntersecting: true }]));
      expect(img.getAttribute("src")).toBe(thumb);
      expect(img.getAttribute("srcset")).toBe(`${thumb}&size=s 270w, ${thumb} 480w`);
      expect(img.hasAttribute("data-thumb-pending")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("clears the loaded flag when a recycled cell asks for another photo", async () => {
    /** @type {((entries: any[]) => void) | null} */
    let notify = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb, opts) {
          if (opts?.rootMargin?.endsWith("px 0px")) notify = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.resetModules();
    try {
      const { default: FreshThumb } = await import("./PhotoThumb.jsx");
      const first = { ...photo, thumb: "/first.jpg" };
      const second = { ...photo, name: "second.jpg", thumb: "/second.jpg" };
      const view = render(<FreshThumb photo={first} />);
      const img = view.container.querySelector("img");
      act(() => notify?.([{ target: img, isIntersecting: true }]));
      fireEvent.load(img);
      expect(img.dataset.thumbLoaded).toBe("1");

      view.rerender(<FreshThumb photo={second} />);
      act(() => notify?.([{ target: img, isIntersecting: true }]));
      expect(img.getAttribute("src")).toBe("/second.jpg");
      expect(img.dataset.thumbLoaded).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("PhotoThumb loaded state without IntersectionObserver", () => {
  it("clears the loaded flag when the src changes on the ungated path", () => {
    const first = { ...photo, thumb: "/a.jpg" };
    const second = { ...photo, name: "b.jpg", thumb: "/b.jpg" };
    const view = render(<PhotoThumb photo={first} />);
    const img = view.container.querySelector("img");
    fireEvent.load(img);
    expect(img.dataset.thumbLoaded).toBe("1");

    view.rerender(<PhotoThumb photo={second} />);
    expect(img.getAttribute("src")).toBe("/b.jpg");
    expect(img.dataset.thumbLoaded).toBeUndefined();

    fireEvent.load(img);
    expect(img.dataset.thumbLoaded).toBe("1");
  });
});
