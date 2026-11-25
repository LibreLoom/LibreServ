import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("shows a cell's full text in the shared tooltip", async () => {
    const user = userEvent.setup();
    const note = `${"a".repeat(239)}b`;
    render(
      <QueryResultTable
        result={{
          columns: ["note"],
          rows: [[note]],
          rowCount: 1,
          truncated: false,
        }}
      />,
    );
    expect(document.querySelector("[title]")).toBeNull();
    await user.hover(screen.getByText(note));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(note);
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
