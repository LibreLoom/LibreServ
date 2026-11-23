import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PhotoInfoPanel from "./PhotoInfoPanel.jsx";

const photo = {
  name: "print.jpg",
  kind: "image",
  path: "/print.jpg",
};

describe("PhotoInfoPanel", () => {
  it("leaves a gutter on every side so the outline is not clipped", () => {
    const { container } = render(
      <PhotoInfoPanel open photo={photo} onClose={() => {}} />,
    );
    const aside = container.querySelector('[data-slot="photo-info-panel"]');
    expect(aside).not.toBeNull();
    expect(aside.className).toMatch(/\boverflow-hidden\b/);
    expect(aside.className).toMatch(/w-\[22\.5rem\]/);

    const shell = aside.firstElementChild;
    // Padding on all sides, including the left. Right-only padding let the
    // ring paint outside the clipping aside.
    expect(shell.className).toMatch(/\bp-3\b/);
    expect(shell.className).not.toMatch(/\bpr-3\b/);
    expect(shell.className).not.toMatch(/\bpy-3\b/);

    const card = shell.firstElementChild;
    expect(card.className).toMatch(/\bring-2\b/);
    expect(card.className).toMatch(/\brounded-large-element\b/);
  });

  it("omits megapixels for a tiny image instead of saying 0 MP", () => {
    render(
      <PhotoInfoPanel open photo={{ ...photo, width: 1, height: 1 }} onClose={() => {}} />,
    );
    expect(screen.getByText(/1 × 1/)).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ MP$/)).not.toBeInTheDocument();
  });

  it("shows whole megapixels for a normal image", () => {
    render(
      <PhotoInfoPanel open photo={{ ...photo, width: 4000, height: 3000 }} onClose={() => {}} />,
    );
    expect(screen.getByText("12 MP")).toBeInTheDocument();
  });
});
