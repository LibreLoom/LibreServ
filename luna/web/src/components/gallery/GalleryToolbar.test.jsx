import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar.jsx";

const SEGMENTS = [
  { value: "library", label: "Library" },
  { value: "albums", label: "Albums" },
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
  it("keeps search hidden until the search icon is clicked", async () => {
    const user = userEvent.setup();
    renderToolbar();
    expect(screen.queryByLabelText(/Search photos/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search photos/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Search photos/i }));
    expect(screen.getByLabelText(/Search photos/i)).toBeInTheDocument();
  });

  it("shows a Filters button", () => {
    renderToolbar({ filterActiveCount: 2 });
    expect(screen.getByRole("button", { name: /Filters, 2 active/i })).toBeInTheDocument();
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
});
