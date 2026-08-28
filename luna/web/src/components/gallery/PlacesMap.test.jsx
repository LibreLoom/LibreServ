import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlacePopupContent } from "./PlacesMap.jsx";

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
});
