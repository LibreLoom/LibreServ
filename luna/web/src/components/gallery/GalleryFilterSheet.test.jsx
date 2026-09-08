import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GalleryFilterSheet, { EMPTY_FILTERS } from "./GalleryFilterSheet.jsx";

vi.mock("../../lib/api", () => ({
  getJson: vi.fn(async (url) => {
    if (String(url).includes("/cameras")) {
      return { cameras: [{ make: "Canon", model: "EOS", count: 3 }] };
    }
    if (String(url).includes("/filter-facets")) {
      const err = new Error("not found");
      err.status = 404;
      throw err;
    }
    return {};
  }),
}));

// Leaflet needs a real layout size; stub the map for section render tests.
vi.mock("./GeozoneMap.jsx", () => ({
  default: function MockGeozoneMap() {
    return <div data-testid="geozone-map">Drag on the map to choose an area.</div>;
  },
}));

describe("GalleryFilterSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders filter sections", async () => {
    render(
      <GalleryFilterSheet
        open
        value={{ ...EMPTY_FILTERS }}
        onClose={vi.fn()}
        onApply={vi.fn()}
        onOpenDates={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: /^When$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Where$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Camera$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Look$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Time of day$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Saved filters$/i })).toBeInTheDocument();
    expect(screen.getByTestId("geozone-map")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear all/i })).toBeInTheDocument();
  });
});
