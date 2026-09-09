import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GeozoneMap, { bboxToBounds, boundsToBbox } from "./GeozoneMap.jsx";

vi.mock("react-leaflet", () => {
  const mapStub = {
    setView: () => {},
    fitBounds: () => {},
    getContainer: () => {
      const el = document.createElement("div");
      el.style.cursor = "default";
      el.style.touchAction = "auto";
      return el;
    },
    dragging: { enable: vi.fn(), disable: vi.fn() },
    touchZoom: { enable: vi.fn(), disable: vi.fn() },
    doubleClickZoom: { enable: vi.fn(), disable: vi.fn() },
  };
  return {
    MapContainer: ({ children, className }) => (
      <div data-testid="map-container" className={className}>
        {children}
      </div>
    ),
    TileLayer: () => <div data-testid="tile-layer" />,
    CircleMarker: () => <div data-testid="circle-marker" />,
    Rectangle: ({ bounds }) => <div data-testid="rectangle" data-bounds={JSON.stringify(bounds)} />,
    useMap: () => mapStub,
    useMapEvents: () => null,
  };
});

describe("GeozoneMap helpers", () => {
  it("round-trips bbox and leaflet bounds", () => {
    const bbox = /** @type {[number, number, number, number]} */ ([-10, 20, -5, 30]);
    const bounds = bboxToBounds(bbox);
    expect(bounds).toEqual([
      [20, -10],
      [30, -5],
    ]);
    expect(boundsToBbox(bounds)).toEqual(bbox);
  });

  it("returns null for invalid bbox", () => {
    expect(bboxToBounds(null)).toBeNull();
    expect(bboxToBounds(/** @type {any} */ ([1, 2, 3]))).toBeNull();
  });
});

describe("GeozoneMap component", () => {
  it("renders mode toggle with Pan map and Draw area options", () => {
    render(<GeozoneMap value={null} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Pan map/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draw area/i })).toBeInTheDocument();
    expect(screen.getByText("No area selected")).toBeInTheDocument();
  });

  it("switches interaction mode when buttons are clicked", async () => {
    const user = userEvent.setup();
    render(<GeozoneMap value={null} onChange={vi.fn()} />);

    const panBtn = screen.getByRole("button", { name: /Pan map/i });
    const drawBtn = screen.getByRole("button", { name: /Draw area/i });

    // Initial mode when value is null is draw
    expect(screen.getByText(/Click & drag or drag with finger to select an area/i)).toBeInTheDocument();

    await user.click(panBtn);
    expect(screen.getByText(/Drag to move around the map/i)).toBeInTheDocument();

    await user.click(drawBtn);
    expect(screen.getByText(/Click & drag or drag with finger to select an area/i)).toBeInTheDocument();
  });

  it("renders coordinate summary and Clear zone button when value is provided", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <GeozoneMap
        value={[-122.5, 37.7, -122.3, 37.9]}
        onChange={onChange}
      />
    );

    expect(screen.getByText(/37.70–37.90 lat · -122.50–-122.30 lon/i)).toBeInTheDocument();
    const clearBtn = screen.getByRole("button", { name: /Clear zone/i });
    expect(clearBtn).toBeInTheDocument();

    await user.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("allows clicking Redraw to switch back to draw mode", async () => {
    const user = userEvent.setup();
    render(
      <GeozoneMap
        value={[-122.5, 37.7, -122.3, 37.9]}
        onChange={vi.fn()}
      />
    );

    const redrawBtn = screen.getByRole("button", { name: /Redraw/i });
    await user.click(redrawBtn);
    expect(screen.getByText(/Click & drag or drag with finger to select an area/i)).toBeInTheDocument();
  });
});
