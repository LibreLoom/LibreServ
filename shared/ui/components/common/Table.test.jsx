import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Table from "./Table.jsx";

const INSETS = ["px-3", "pl-3", "pr-3", "px-1"];

/** @param {Element} el */
function insetsOf(el) {
  return INSETS.filter((className) => el.classList.contains(className));
}

describe("Table", () => {
  it("gives each header label the same horizontal insets as its column's cells", () => {
    render(
      <Table
        columns={[
          { key: "id", label: "Id" },
          { key: "name", label: "Name" },
          { key: "kind", label: "Kind" },
        ]}
        data={[{ id: 1, name: "Ada", kind: "Person" }]}
        rowKey="id"
      />,
    );

    const headers = screen.getAllByRole("columnheader").map(insetsOf);
    const cells = screen.getAllByRole("cell").map(insetsOf);
    expect(headers).toEqual(cells);
  });

  it("keeps the insets equal for a single column", () => {
    render(
      <Table columns={[{ key: "name", label: "Name" }]} data={[{ name: "Ada" }]} />,
    );

    expect(insetsOf(screen.getByRole("columnheader"))).toEqual(
      insetsOf(screen.getByRole("cell")),
    );
  });
});
