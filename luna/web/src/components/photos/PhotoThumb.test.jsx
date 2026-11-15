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
