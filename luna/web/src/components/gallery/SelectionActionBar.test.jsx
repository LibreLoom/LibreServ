import { act, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SelectionActionBar from "./SelectionActionBar.jsx";

function renderBar(props = {}) {
  return render(
    <SelectionActionBar
      visible
      count={0}
      onSelectAll={vi.fn()}
      onTrash={vi.fn()}
      onClear={vi.fn()}
      {...props}
    />,
  );
}

describe("SelectionActionBar", () => {
  it("renders while visible even with 0 selected", () => {
    renderBar();
    expect(
      screen.getByRole("toolbar", { name: "Actions for selected photos" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("renders nothing when not visible", () => {
    renderBar({ visible: false });
    expect(
      screen.queryByRole("toolbar", { name: "Actions for selected photos" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Select all live but disables selection actions at 0 selected", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Select all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Trash" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
  });

  it("enables selection actions once photos are selected", () => {
    renderBar({ count: 3 });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trash" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeEnabled();
  });

  it("unmounts once visibility is removed (no WAAPI in jsdom)", () => {
    const { rerender } = renderBar();
    expect(
      screen.getByRole("toolbar", { name: "Actions for selected photos" }),
    ).toBeInTheDocument();
    rerender(<SelectionActionBar visible={false} count={0} onSelectAll={vi.fn()} />);
    expect(
      screen.queryByRole("toolbar", { name: "Actions for selected photos" }),
    ).not.toBeInTheDocument();
  });

  it("plays one animation and reverses it for the exit", () => {
    const anim = {
      playbackRate: 1,
      reverse: vi.fn(() => {
        anim.playbackRate = -anim.playbackRate;
      }),
      cancel: vi.fn(),
      onfinish: null,
    };
    const animate = vi.fn(() => /** @type {any} */ (anim));
    const hadAnimate = "animate" in Element.prototype;
    const original = Element.prototype.animate;
    Element.prototype.animate = /** @type {any} */ (animate);
    try {
      const { rerender } = renderBar();
      expect(animate).toHaveBeenCalledTimes(1);

      rerender(<SelectionActionBar visible={false} count={0} onSelectAll={vi.fn()} />);
      expect(anim.reverse).toHaveBeenCalledTimes(1);
      // The exit reuses the same animation — no second el.animate() call.
      expect(animate).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("toolbar", { name: "Actions for selected photos" }),
      ).toBeInTheDocument();

      // Re-entering mid-exit turns the same animation around again.
      rerender(<SelectionActionBar visible count={0} onSelectAll={vi.fn()} />);
      expect(anim.reverse).toHaveBeenCalledTimes(2);

      // A reversed finish unmounts the bar.
      rerender(<SelectionActionBar visible={false} count={0} onSelectAll={vi.fn()} />);
      act(() => anim.onfinish?.());
      expect(
        screen.queryByRole("toolbar", { name: "Actions for selected photos" }),
      ).not.toBeInTheDocument();
    } finally {
      if (hadAnimate) Element.prototype.animate = original;
      else delete Element.prototype.animate;
    }
  });

  it("fires onSelectAll with 0 selected", () => {
    const onSelectAll = vi.fn();
    renderBar({ onSelectAll });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(onSelectAll).toHaveBeenCalled();
  });
});
