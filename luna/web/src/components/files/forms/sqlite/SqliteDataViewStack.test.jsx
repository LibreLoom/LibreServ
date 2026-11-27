import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SqliteDataViewStack from "./SqliteDataViewStack.jsx";

function mount(overrides = {}) {
  const props = {
    view: /** @type {"table" | "query"} */ ("table"),
    hasResult: true,
    table: <div>Table rows</div>,
    result: <div>Query rows</div>,
    ...overrides,
  };
  const view = render(<SqliteDataViewStack {...props} />);
  return { ...view, props };
}

/** @param {"table" | "query"} name */
function pane(name) {
  const slot = name === "table" ? "table" : "result";
  return /** @type {HTMLElement} */ (
    document.querySelector(`[data-slot="sqlite-${slot}-view"]`)
  );
}

describe("SqliteDataViewStack", () => {
  it("keeps both views mounted and exposes only the active one", () => {
    mount();
    expect(screen.getByText("Table rows")).toBeInTheDocument();
    expect(screen.getByText("Query rows")).toBeInTheDocument();
    expect(pane("table")).not.toHaveAttribute("aria-hidden");
    expect(pane("table")).not.toHaveAttribute("inert");
    expect(pane("query")).toHaveAttribute("aria-hidden", "true");
    expect(pane("query")).toHaveAttribute("inert");
  });

  it("slides the views along the segment's direction", () => {
    const { rerender, props } = mount();
    expect(pane("table").className).toContain("translate-x-0");
    expect(pane("query").className).toContain("translate-x-3");

    rerender(<SqliteDataViewStack {...props} view="query" />);
    expect(pane("table").className).toContain("-translate-x-3");
    expect(pane("table").className).toContain("opacity-0");
    expect(pane("query").className).toContain("translate-x-0");
    expect(pane("query").className).toContain("opacity-100");
    expect(pane("table")).toHaveAttribute("aria-hidden", "true");
    expect(pane("query")).not.toHaveAttribute("aria-hidden");
  });

  it("renders no result pane before there is a result", () => {
    mount({ hasResult: false, result: null });
    expect(screen.getByText("Table rows")).toBeInTheDocument();
    expect(pane("query")).toBeNull();
  });

  it("keeps a cleared result in the outgoing pane until its fade ends", () => {
    const { rerender, props } = mount({ view: "query" });
    rerender(<SqliteDataViewStack {...props} view="table" hasResult={false} result={null} />);
    const result = pane("query");
    expect(result).toHaveAttribute("inert");
    expect(result).toHaveAttribute("aria-hidden", "true");
    expect(result).toHaveTextContent("Query rows");
    expect(pane("table")).not.toHaveAttribute("inert");

    // Browsers send transitionend for each property; only the pane's opacity
    // transition should retire it.
    const end = new Event("transitionend", { bubbles: true });
    Object.defineProperty(end, "propertyName", { value: "opacity" });
    fireEvent(result, end);
    expect(pane("query")).toBeNull();
  });
});
