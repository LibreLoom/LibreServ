import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar.jsx";

const SEGMENTS = [
  { value: "library", label: "Library" },
  { value: "albums", label: "Albums" },
  { value: "places", label: "Places" },
  { value: "archive", label: "Archive" },
];

function renderToolbar(overrides = {}) {
  const props = {
    segments: SEGMENTS,
    segment: "library",
    onSegmentChange: vi.fn(),
    query: "",
    onQueryChange: vi.fn(),
    onOpenFilters: vi.fn(),
    onOpenDates: vi.fn(),
    onColumnsChange: vi.fn(),
    columns: 6,
    showSelect: true,
    onSelectModeChange: vi.fn(),
    ...overrides,
  };
  render(<GalleryToolbar {...props} />);
  return props;
}

describe("GalleryToolbar", () => {
  it("splits apart on small screens into two bars with category bar below search bar", () => {
    const { container } = render(
      <GalleryToolbar
        segments={SEGMENTS}
        segment="library"
        onSegmentChange={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        isDesktop={false}
      />
    );
    const searchInput = screen.getByRole("searchbox", { name: /Search photos/i });
    expect(searchInput).toHaveAttribute("id", "photo-search-mobile");

    // Two distinct pillShell containers on mobile
    const bars = container.querySelectorAll('[data-slot="gallery-toolbar"] > div');
    expect(bars.length).toBe(2);

    // First bar contains the search input
    expect(bars[0]).toContainElement(searchInput);

    // Second bar (below search bar) contains the category selector
    const segmentedControl = screen.getByRole("radiogroup");
    expect(bars[1]).toContainElement(segmentedControl);
    expect(segmentedControl).toHaveClass("w-full");
  });

  it("renders a single unified bar on desktop", () => {
    const { container } = render(
      <GalleryToolbar
        segments={SEGMENTS}
        segment="library"
        onSegmentChange={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        isDesktop={true}
      />
    );
    const searchInput = screen.getByRole("searchbox", { name: /Search photos/i });
    expect(searchInput).toHaveAttribute("id", "photo-search");

    // Single bar on desktop
    const bars = container.querySelectorAll('[data-slot="gallery-toolbar"] > div');
    expect(bars.length).toBe(1);

    // Both search input and segmented control are inside the single bar
    const segmentedControl = screen.getByRole("radiogroup");
    expect(bars[0]).toContainElement(searchInput);
    expect(bars[0]).toContainElement(segmentedControl);
  });

  it("shows a Filters button", () => {
    renderToolbar({ filterActiveCount: 2 });
    expect(screen.getByRole("button", { name: /Filters, 2 active/i })).toBeInTheDocument();
  });

  it("allows typing and clearing search queries", async () => {
    const onQueryChange = vi.fn();
    renderToolbar({ query: "sunset", onQueryChange });

    const searchInput = screen.getByRole("searchbox", { name: /Search photos/i });
    expect(searchInput).toHaveValue("sunset");

    // Clear button appears when query is non-empty
    const clearBtn = screen.getByRole("button", { name: /Clear search/i });
    fireEvent.click(clearBtn);
    expect(onQueryChange).toHaveBeenCalledWith({ target: { value: "" } });
  });

  it("puts grid density in the More menu, not the primary bar", async () => {
    const user = userEvent.setup();
    const onColumnsChange = vi.fn();
    renderToolbar({ onColumnsChange });
    expect(screen.queryByLabelText(/Grid density/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /More options/i }));
    expect(screen.getByText(/Grid density/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /4 columns/i }));
    expect(onColumnsChange).toHaveBeenCalledWith(4);
  });

  it("offers Keyboard shortcuts in the More menu", async () => {
    const user = userEvent.setup();
    const onOpenShortcuts = vi.fn();
    renderToolbar({ onOpenShortcuts });
    await user.click(screen.getByRole("button", { name: /More options/i }));
    await user.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/i }));
    expect(onOpenShortcuts).toHaveBeenCalled();
  });
});
