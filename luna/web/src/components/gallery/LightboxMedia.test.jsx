import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import LightboxMedia from "./LightboxMedia.jsx";

const photo = {
  name: "beach.jpg",
  kind: "image",
  thumb: "/api/v1/gallery/thumb?x=1",
};
const FULL_SRC = "/api/v1/content/beach.jpg";

/**
 * @param {{ photo?: object }} [options]
 */
function renderMedia({ photo: photoOverrides, ...props } = {}) {
  const utils = render(
    <LightboxMedia photo={{ ...photo, ...photoOverrides }} src={FULL_SRC} {...props} />,
  );
  return {
    ...utils,
    thumb: /** @type {HTMLImageElement|null} */ (
      utils.container.querySelector('img[aria-hidden="true"]')
    ),
    full: /** @type {HTMLImageElement|null} */ (
      utils.container.querySelector(`img[src="${FULL_SRC}"]`)
    ),
  };
}

describe("LightboxMedia progressive reveal", () => {
  it("shows the thumbnail small while the full image loads hidden", () => {
    const { thumb, full } = renderMedia();

    expect(thumb).toHaveAttribute("src", photo.thumb);
    expect(thumb.className).toContain("max-h-[45%]");
    expect(full).toHaveStyle({ opacity: "0" });
  });

  it("grows the full image in once it loads and fades the thumbnail out", async () => {
    const { thumb, full } = renderMedia();

    fireEvent.load(full);
    // Primed: media pinned at thumbnail scale while fading in.
    expect(full.style.transform).toMatch(/^scale\(/);

    await waitFor(() => expect(full.style.transform).toBe(""));
    expect(full).toHaveStyle({ opacity: "1" });
    expect(thumb).toHaveStyle({ opacity: "0" });
  });

  it("reveals a video once its first frame is ready", async () => {
    const { container } = render(
      <LightboxMedia
        photo={{ name: "clip.mp4", kind: "video", thumb: "/t.jpg" }}
        src="/api/v1/content/clip.mp4"
      />,
    );
    const video = /** @type {HTMLVideoElement} */ (container.querySelector("video"));
    expect(video).toHaveStyle({ opacity: "0" });

    fireEvent.loadedData(video);
    await waitFor(() => expect(video).toHaveStyle({ opacity: "1" }));
  });

  it("still reveals the image when no thumbnail exists", async () => {
    const { thumb, full } = renderMedia({ photo: { thumb: undefined } });
    expect(thumb).toBeNull();
    expect(full).toHaveStyle({ opacity: "0" });

    fireEvent.load(full);
    await waitFor(() => expect(full).toHaveStyle({ opacity: "1" }));
  });

  it("reveals immediately under prefers-reduced-motion", async () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: String(query).includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      const { full } = renderMedia();
      fireEvent.load(full);
      await waitFor(() => expect(full).toHaveStyle({ opacity: "1" }));
      expect(full.style.transform).toBe("");
    } finally {
      window.matchMedia = original;
    }
  });

  it("keeps the HEIC fallback: swaps to the thumbnail src on error", () => {
    const { full } = renderMedia();

    fireEvent.error(full);
    expect(full.src).toBe(new URL(photo.thumb, window.location.href).href);
  });

  it("reveals anyway when the full image errors and no thumb fallback applies", async () => {
    const { full } = renderMedia({ photo: { thumb: undefined } });

    fireEvent.error(full);
    await waitFor(() => expect(full).toHaveStyle({ opacity: "1" }));
  });
});
