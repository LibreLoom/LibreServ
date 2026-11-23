import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SqliteGrid from "./SqliteGrid.jsx";

const TABLE = {
  name: "answers",
  columns: [
    { name: "id", type: "INTEGER", pk: 1, notNull: true, generated: false, hidden: false },
    { name: "name", type: "TEXT", pk: 0, notNull: false, generated: false, hidden: false },
  ],
  primaryKey: ["id"],
  rowCount: 1,
};

const ROWS = [[1, "Ada"]];

function mount(overrides = {}) {
  const props = {
    table: TABLE,
    rows: ROWS,
    total: 1,
    page: 1,
    canWrite: true,
    busy: false,
    loading: false,
    onPageChange: vi.fn(),
    onUpdateCell: vi.fn().mockResolvedValue(undefined),
    onRenameColumn: vi.fn(),
    onDropColumn: vi.fn(),
    onDeleteRow: vi.fn(),
    onAddRow: vi.fn(),
    onAddColumn: vi.fn(),
    ...overrides,
  };
  const view = render(<SqliteGrid {...props} />);
  return { ...view, props };
}

describe("SqliteGrid", () => {
  it("shows column names, types, and the primary key", () => {
    mount();
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("INTEGER")).toBeInTheDocument();
    expect(screen.getByText("TEXT")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Primary key")).toHaveLength(1);
    expect(screen.getByText(/1–1 of 1/)).toBeInTheDocument();
  });

  it("uses the shared tooltip for the primary key, not a native title", async () => {
    const user = userEvent.setup();
    mount();
    expect(document.querySelector("[title]")).toBeNull();
    await user.hover(screen.getByLabelText("Primary key"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Primary key. Use SQL to change it.",
    );
  });

  it("adds rows and columns from inside the grid", () => {
    const { props } = mount();
    const addRow = screen.getByRole("button", { name: "Add row" });
    expect(addRow).toHaveAttribute("data-variant", "ghost");
    fireEvent.click(addRow);
    expect(props.onAddRow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(props.onAddColumn).toHaveBeenCalledTimes(1);
  });

  it("outlines Add row under a mono No rows yet note", () => {
    const { props } = mount({ rows: [], total: 0 });
    const note = screen.getByText("No rows yet.");
    expect(note).toHaveClass("font-mono");
    const add = screen.getByRole("button", { name: "Add row" });
    expect(add).toHaveAttribute("data-variant", "outline");
    expect(screen.getAllByRole("button", { name: "Add row" })).toHaveLength(1);
    expect(
      note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(add);
    expect(props.onAddRow).toHaveBeenCalledTimes(1);
  });

  it("says No rows without an Add row when the table is read-only", () => {
    mount({ rows: [], total: 0, canWrite: false });
    expect(screen.getByText("No rows.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add row" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Add row below an empty page of a table that has rows", () => {
    mount({ rows: [], total: 5, page: 2 });
    expect(screen.getByText("No rows on this page.")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add row" });
    expect(screen.getAllByRole("button", { name: "Add row" })).toHaveLength(1);
    expect(add).toHaveAttribute("data-variant", "ghost");
  });

  it("shows no row or column actions when the table is read-only", () => {
    mount({ canWrite: false });
    expect(
      screen.queryByRole("button", { name: "Add row" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add column" }),
    ).not.toBeInTheDocument();
  });

  it("opens a cell on double click and cancels with Escape", async () => {
    mount();
    fireEvent.doubleClick(screen.getByText("Ada"));
    const input = await screen.findByRole("textbox", {
      name: "Edit name, row 1",
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("commits a changed cell on Enter", async () => {
    const { props } = mount();
    fireEvent.doubleClick(screen.getByText("Ada"));
    const input = await screen.findByRole("textbox", {
      name: "Edit name, row 1",
    });
    fireEvent.change(input, { target: { value: "Grace" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onUpdateCell).toHaveBeenCalledWith(
      0,
      TABLE.columns[1],
      "Grace",
    );
  });

  it("shows blobs as hex and refuses to edit them inline", () => {
    mount({
      table: {
        ...TABLE,
        columns: [
          TABLE.columns[0],
          {
            name: "payload",
            type: "BLOB",
            pk: 0,
            notNull: false,
            generated: false,
            hidden: false,
          },
        ],
      },
      rows: [[1, new Uint8Array([0xde, 0xad])]],
    });
    const blob = screen.getByText("de ad · 2 B");
    expect(blob).toBeInTheDocument();
    fireEvent.doubleClick(blob);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("asks to delete the row that was clicked", async () => {
    const { props } = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete row 1" }),
    );
    expect(props.onDeleteRow).toHaveBeenCalledWith(ROWS[0], 0);
  });

  it("drops cell editing and row actions in a read-only database", () => {
    mount({ canWrite: false });
    expect(
      screen.queryByRole("button", { name: "Delete row 1" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Actions for column/),
    ).not.toBeInTheDocument();
  });
});
