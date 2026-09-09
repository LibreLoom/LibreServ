import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SegmentedControl from "./SegmentedControl.jsx";
import * as haptics from "../../utils/haptics.js";

describe("SegmentedControl", () => {
  let hapticSpy;

  beforeEach(() => {
    hapticSpy = vi.spyOn(haptics, "haptic").mockImplementation(() => {});
  });

  afterEach(() => {
    hapticSpy.mockRestore();
  });

  const OPTIONS = [
    { value: "library", label: "Library" },
    { value: "favorites", label: "Favorites" },
    { value: "places", label: "Places" },
    { value: "albums", label: "Albums" },
  ];

  it("enforces equal column widths with repeat(N, minmax(0, 1fr)) to keep indicator centered", () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="library" onChange={vi.fn()} />
    );

    const radiogroup = container.querySelector('[data-slot="segmented-control"]');
    expect(radiogroup).toHaveStyle({
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    });

    const indicator = container.querySelector('[data-slot="segmented-control-indicator"]');
    expect(indicator).toHaveStyle({
      width: "calc((100% - 6px) / 4)",
      transform: "translateX(0%)",
    });
  });

  it("updates indicator transform when active segment changes", () => {
    const { container, rerender } = render(
      <SegmentedControl options={OPTIONS} value="favorites" onChange={vi.fn()} />
    );

    let indicator = container.querySelector('[data-slot="segmented-control-indicator"]');
    expect(indicator).toHaveStyle({
      transform: "translateX(100%)",
    });

    rerender(
      <SegmentedControl options={OPTIONS} value="places" onChange={vi.fn()} />
    );
    indicator = container.querySelector('[data-slot="segmented-control-indicator"]');
    expect(indicator).toHaveStyle({
      transform: "translateX(200%)",
    });
  });

  it("emits selection haptic and calls onChange when selecting an option", () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={OPTIONS} value="library" onChange={onChange} />);

    const placesBtn = screen.getByRole("radio", { name: "Places" });
    fireEvent.click(placesBtn);

    expect(hapticSpy).toHaveBeenCalledWith("selection");
    expect(onChange).toHaveBeenCalledWith("places");
  });

  it("emits error haptic and calls onDisabledClick when disabled option is clicked", () => {
    const onChange = vi.fn();
    const onDisabledClick = vi.fn();
    const optionsWithDisabled = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
    ];
    render(
      <SegmentedControl
        options={optionsWithDisabled}
        value="a"
        onChange={onChange}
        onDisabledClick={onDisabledClick}
      />
    );

    const disabledBtn = screen.getByRole("radio", { name: "B" });
    fireEvent.click(disabledBtn);

    expect(hapticSpy).toHaveBeenCalledWith("error");
    expect(onDisabledClick).toHaveBeenCalledWith("b");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies min-w-0 and truncate to buttons and labels", () => {
    render(<SegmentedControl options={OPTIONS} value="library" onChange={vi.fn()} />);

    const btn = screen.getByRole("radio", { name: "Favorites" });
    expect(btn).toHaveClass("min-w-0");

    const label = btn.querySelector("span");
    expect(label).toHaveClass("truncate", "text-center", "w-full");
  });
});
