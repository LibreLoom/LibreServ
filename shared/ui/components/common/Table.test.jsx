import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Table from "./Table.jsx";

const HORIZONTAL_PADDING = /^(?:md:)?p[lxr]-/;

/** @param {Element} el */
function insetsOf(el) {
  return [...el.classList]
    .filter((className) => HORIZONTAL_PADDING.test(className))
    .sort();
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
      <Table columns={[{ key: "name", label: "Name" }]} data={[{ name: "Ada" }]} rowKey="name" />,
    );

    expect(insetsOf(screen.getByRole("columnheader"))).toEqual(
      insetsOf(screen.getByRole("cell")),
    );
  });

  it("gives every column a full gutter on phones", () => {
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

    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).toHaveClass("pl-3", "pr-3", "md:pr-0");
    expect(headers[1]).toHaveClass("px-3", "md:px-1");
    expect(headers[2]).toHaveClass("pl-3", "pr-3", "md:pl-0");
  });
});
