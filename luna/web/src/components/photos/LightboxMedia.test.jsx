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
 * @param {{ photo?: object, lite?: boolean }} [options]
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

  it("thumbnail-only in lite mode — no full image request", () => {
    const { thumb, full } = renderMedia({ lite: true });
    expect(thumb).toBeInTheDocument();
    expect(full).toBeNull();
  });

  it("keeps the HEIC fallback: swaps to the thumbnail src on error", () => {
    const { full } = renderMedia({ photo: { name: "beach.heic" } });

    fireEvent.error(full);
    expect(full.src).toBe(new URL(photo.thumb, window.location.href).href);
  });

  it("does not fall back to the thumbnail for ordinary photos — error wins", async () => {
    const { full, getByText } = renderMedia();

    fireEvent.error(full);

    await waitFor(() =>
      expect(getByText(/can't be displayed in the browser/)).toBeInTheDocument());
    expect(full.src).toBe(new URL(FULL_SRC, window.location.href).href);
  });

  it("labels the HEIC thumbnail fallback as a small preview", async () => {
    const { full, getByText } = renderMedia({ photo: { name: "beach.heic" } });

    fireEvent.error(full);
    fireEvent.load(full); // the swapped-in thumbnail resolves

    await waitFor(() =>
      expect(getByText(/small preview/)).toBeInTheDocument());
  });

  it("shows a can't-play notice with a download link when the video errors", async () => {
    const { container, getByRole, getByText } = render(
      <LightboxMedia
        photo={{ name: "clip.mp4", kind: "video", thumb: "/t.jpg" }}
        src="/api/v1/content/clip.mp4"
        downloadSrc="/api/v1/download/clip.mp4"
      />,
    );
    const video = /** @type {HTMLVideoElement} */ (container.querySelector("video"));

    fireEvent.error(video);

    await waitFor(() =>
      expect(getByText(/can't play in the browser/)).toBeInTheDocument());
    const link = getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href", "/api/v1/download/clip.mp4");
    expect(link).toHaveAttribute("download");
    // The dead player unmounts — no controls hanging over the notice.
    expect(container.querySelector("video")).toBeNull();
    // The thumbnail fades out, leaving the notice on its own.
    expect(container.querySelector('img[aria-hidden="true"]')).toHaveStyle({ opacity: "0" });
  });

  it("shows a can't-display notice when the image errors and no thumb fallback applies", async () => {
    const { full, getByText, container } = renderMedia({ photo: { thumb: undefined } });

    fireEvent.error(full);

    await waitFor(() =>
      expect(getByText(/can't be displayed in the browser/)).toBeInTheDocument());
    expect(container.querySelector(`img[src="${FULL_SRC}"]`)).toBeNull();
  });

  it("shows the notice when the thumbnail fallback also fails", async () => {
    const { full, getByText } = renderMedia({ photo: { name: "beach.heic" } });

    fireEvent.error(full); // full image fails → swaps to thumbnail src
    fireEvent.error(full); // thumbnail fails too → notice

    await waitFor(() =>
      expect(getByText(/can't be displayed in the browser/)).toBeInTheDocument());
  });

  it("clears the failure state when src changes", async () => {
    const { container, getByText, queryByText, rerender } = render(
      <LightboxMedia
        photo={{ name: "clip.mp4", kind: "video" }}
        src="/api/v1/content/clip.mp4"
      />,
    );
    fireEvent.error(/** @type {HTMLVideoElement} */ (container.querySelector("video")));
    await waitFor(() => expect(getByText(/can't play/)).toBeInTheDocument());

    rerender(
      <LightboxMedia
        photo={{ name: "clip.mp4", kind: "video" }}
        src="/api/v1/content/clip-fixed.mp4"
      />,
    );

    await waitFor(() => expect(queryByText(/can't play/)).toBeNull());
    expect(container.querySelector("video")).not.toBeNull();
  });
});
