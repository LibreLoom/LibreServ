import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GalleryFilterSheet, {
  EMPTY_FILTERS,
  datePresetRange,
} from "./GalleryFilterSheet.jsx";

vi.mock("../../lib/api", () => ({
  getJson: vi.fn(async (url) => {
    if (String(url).includes("/cameras")) {
      return { cameras: [{ make: "Canon", model: "EOS", count: 3 }] };
    }
    if (String(url).includes("/filter-facets")) {
      const err = /** @type {Error & { status?: number }} */ (new Error("not found"));
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

describe("datePresetRange", () => {
  it("returns last-7 / this-month / this-year ranges", () => {
    const last7 = datePresetRange("last7");
    expect(last7.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last7.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datePresetRange("thisMonth").from.endsWith("-01")).toBe(true);
    expect(datePresetRange("thisYear").from.endsWith("-01-01")).toBe(true);
  });
});

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

  it("offers When quick presets including Undated", async () => {
    render(
      <GalleryFilterSheet
        open
        value={{ ...EMPTY_FILTERS }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: /Last 7 days/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /This month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /This year/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Undated$/i })).toBeInTheDocument();
  });

  it("offers album membership filters in Look", async () => {
    render(
      <GalleryFilterSheet
        open
        value={{ ...EMPTY_FILTERS }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Album membership/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^In an album$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Not in an album$/i })).toBeInTheDocument();
  });

  it("applies Undated preset into onApply payload", async () => {
    const onApply = vi.fn();
    render(
      <GalleryFilterSheet
        open
        value={{ ...EMPTY_FILTERS }}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Undated$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));
    expect(onApply).toHaveBeenCalled();
    expect(onApply.mock.calls[0][0].undated).toBe(true);
  });
});
