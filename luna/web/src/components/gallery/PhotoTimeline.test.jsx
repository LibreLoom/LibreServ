import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PhotoThumb from "./PhotoThumb.jsx";
import PhotoTimeline from "./PhotoTimeline.jsx";

describe("PhotoThumb cascading animation", () => {
  it("renders with cascade animation and reduced-motion accessibility classes", () => {
    const photo = { name: "beach.jpg", path: "beach.jpg", drive_id: "d1", thumb: "/t.jpg" };
    render(<PhotoThumb photo={photo} index={2} />);

    const button = screen.getByRole("button", { name: "beach.jpg" });
    expect(button.className).toContain("animate-cascade-in");
    expect(button.className).toContain("motion-reduce:animate-none");
    expect(button.className).toContain("motion-reduce:transition-none");
  });

  it("calculates animationDelay sequentially and sets animationFillMode backwards", () => {
    const photo = { name: "sunset.jpg", path: "sunset.jpg", drive_id: "d1" };
    render(<PhotoThumb photo={photo} index={4} />);

    const button = screen.getByRole("button", { name: "sunset.jpg" });
    // 4 * 35ms = 140ms
    expect(button.style.animationDelay).toBe("140ms");
    expect(button.style.animationFillMode).toBe("backwards");
  });

  it("caps animationDelay at 30 items (1050ms)", () => {
    const photo = { name: "mountain.jpg", path: "mountain.jpg", drive_id: "d1" };
    render(<PhotoThumb photo={photo} index={45} />);

    const button = screen.getByRole("button", { name: "mountain.jpg" });
    // min(45, 30) * 35ms = 1050ms
    expect(button.style.animationDelay).toBe("1050ms");
    expect(button.style.animationFillMode).toBe("backwards");
  });

  it("fades thumbnail image in smoothly when onLoad triggers", () => {
    const photo = { name: "photo.jpg", path: "photo.jpg", drive_id: "d1", thumb: "/thumb.jpg" };
    const { container } = render(<PhotoThumb photo={photo} index={0} />);

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.className).toContain("motion-safe:transition-[opacity,transform]");
    expect(img?.className).toContain("motion-reduce:opacity-100");
    expect(img?.className).toContain("opacity-0");

    fireEvent.load(img);
    expect(img?.className).toContain("opacity-100");
  });
});

describe("PhotoTimeline cascading stagger", () => {
  it("passes sequential index offsets across multiple date groups", () => {
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p2.jpg", path: "p2.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p3.jpg", path: "p3.jpg", drive_id: "d1", taken_at: 1_600_000_000 },
    ];

    render(<PhotoTimeline photos={photos} onOpen={vi.fn()} />);

    const b1 = screen.getByRole("button", { name: "p1.jpg" });
    const b2 = screen.getByRole("button", { name: "p2.jpg" });
    const b3 = screen.getByRole("button", { name: "p3.jpg" });

    expect(b1.style.animationDelay).toBe("0ms");
    expect(b2.style.animationDelay).toBe("35ms");
    expect(b3.style.animationDelay).toBe("70ms");
  });
});
