import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PlacesMap, { PlacePopupContent } from "./PlacesMap.jsx";

vi.mock("react-leaflet", () => {
  const mapStub = {
    setView: () => {},
    fitBounds: () => {},
    invalidateSize: () => {},
    getContainer: () => {
      const el = document.createElement("div");
      el.style.cursor = "default";
      el.style.touchAction = "auto";
      return el;
    },
    getZoom: () => 4,
    getBounds: () => ({
      getWest: () => -180,
      getSouth: () => -90,
      getEast: () => 180,
      getNorth: () => 90,
    }),
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
    TileLayer: (props) => (
      <div
        data-testid="tile-layer"
        data-referrer-policy={props.referrerPolicy}
        data-attribution={props.attribution}
        data-url={props.url}
      />
    ),
    CircleMarker: ({ children }) => <div>{children}</div>,
    Popup: ({ children }) => <div>{children}</div>,
    Tooltip: ({ children }) => <div>{children}</div>,
    Rectangle: ({ bounds }) => <div data-testid="rectangle" data-bounds={JSON.stringify(bounds)} />,
    // Stable map identity — a fresh object each render recreated
    // refreshClusters forever and OOMed the worker.
    useMap: () => mapStub,
    useMapEvents: () => null,
  };
});

describe("PlacePopupContent", () => {
  it("shows a single N photos count without a duplicate badge when label is the count", () => {
    render(
      <PlacePopupContent
        place={{ key: "c1", label: "11 photos", count: 11, cover_thumb: "" }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("11 photos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    // No bare "11" pill badge alongside "11 photos"
    expect(screen.queryByText(/^11$/)).not.toBeInTheDocument();
  });

  it("shows place name plus N photos text when label is a location", () => {
    render(
      <PlacePopupContent
        place={{ key: "p1", label: "Yosemite", count: 11, cover_thumb: "" }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Yosemite")).toBeInTheDocument();
    expect(screen.getByText("11 photos")).toBeInTheDocument();
    expect(screen.queryByText(/^11$/)).not.toBeInTheDocument();
  });

  it("offers Draw a custom area button in popup when onDrawArea is provided", async () => {
    const user = userEvent.setup();
    const onDrawArea = vi.fn();
    render(
      <PlacePopupContent
        place={{ key: "p1", label: "Yosemite", count: 11, cover_thumb: "" }}
        onSelect={vi.fn()}
        onDrawArea={onDrawArea}
      />,
    );

    const drawBtn = screen.getByRole("button", { name: /Draw a custom area…/i });
    expect(drawBtn).toBeInTheDocument();
    await user.click(drawBtn);
    expect(onDrawArea).toHaveBeenCalled();
  });
});

describe("PlacesMap", () => {
  it("shows a loading status while places are fetching", () => {
    render(<PlacesMap places={[]} loading onSelect={vi.fn()} />);
    expect(screen.getByText(/Loading places/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
  });

  it("uses EmptyState (Card pop-in) when there are no places", () => {
    render(<PlacesMap places={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/No places yet/i)).toBeInTheDocument();
    expect(screen.getByText(/location from the camera/i)).toBeInTheDocument();
    const empty = document.querySelector("[data-slot=empty-state]");
    expect(empty).toBeTruthy();
    // EmptyState wraps content in Card; pop-in lives on the card clip.
    const clip = empty?.closest("[data-slot=card-clip]") || empty?.closest("[data-slot=card]");
    expect(clip?.className).toMatch(/pop-in/);
  });

  it("wraps the map in a Card so Places pops in like other gallery panels", () => {
    render(
      <PlacesMap
        places={[{ key: "home", label: "Home", count: 2, lat: 37.7, lon: -122.4 }]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("map-container")).toBeInTheDocument();
    const card = document.querySelector("[data-slot=card]");
    expect(card?.className).toMatch(/pop-in/);
    // Fills the Gallery Places flex parent instead of a capped vh/px height.
    expect(card?.className).toMatch(/\bflex-1\b/);
    expect(card?.className).toMatch(/\bmin-h-0\b/);
    expect(card?.className).not.toMatch(/70vh/);
  });

  it("configures TileLayer with strict-origin-when-cross-origin referrerPolicy", () => {
    render(
      <PlacesMap
        places={[{ key: "home", label: "Home", count: 2, lat: 37.7, lon: -122.4 }]}
        onSelect={vi.fn()}
      />,
    );
    const tileLayer = screen.getByTestId("tile-layer");
    expect(tileLayer).toBeInTheDocument();
    expect(tileLayer).toHaveAttribute("data-referrer-policy", "strict-origin-when-cross-origin");
  });

  it("displays floating draw custom area toolbar when drawMode is active", async () => {
    const user = userEvent.setup();
    const onDrawModeChange = vi.fn();
    render(
      <PlacesMap
        places={[{ key: "home", label: "Home", count: 2, lat: 37.7, lon: -122.4 }]}
        drawMode={true}
        onDrawModeChange={onDrawModeChange}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Draw custom area")).toBeInTheDocument();
    expect(screen.getByText(/Drag across the map/i)).toBeInTheDocument();
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).toBeInTheDocument();

    await user.click(cancelBtn);
    expect(onDrawModeChange).toHaveBeenCalledWith(false);
  });
});
