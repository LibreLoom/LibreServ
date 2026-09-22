import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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
