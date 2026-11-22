import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import QueryResultTable from "./QueryResultTable.jsx";

describe("QueryResultTable", () => {
  it("renders every column and value from the result set", () => {
    render(
      <QueryResultTable
        result={{
          columns: ["id", "name"],
          rows: [[1, "Ada"]],
          rowCount: 1,
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText("No rows")).not.toBeInTheDocument();
  });

  it("shows a blob as hex instead of hiding it behind a byte count", () => {
    render(
      <QueryResultTable
        result={{
          columns: ["payload"],
          rows: [[new Uint8Array([0xde, 0xad])]],
          rowCount: 1,
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText("de ad · 2 B")).toBeInTheDocument();
  });

  it("reports a capped result", () => {
    render(
      <QueryResultTable
        result={{
          columns: ["id"],
          rows: [[1], [2], [3]],
          rowCount: 900,
          truncated: true,
        }}
      />,
    );
    expect(
      screen.getByText(/Showing the first 3 rows/),
    ).toBeInTheDocument();
  });
});
