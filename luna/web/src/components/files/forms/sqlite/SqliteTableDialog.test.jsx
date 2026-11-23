import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SqliteTableDialog from "./SqliteTableDialog.jsx";

function mount(overrides = {}) {
  const props = {
    open: true,
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SqliteTableDialog {...props} />);
  return props;
}

describe("SqliteTableDialog", () => {
  it("starts with an id primary key and submits the table", async () => {
    const props = mount();
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "members" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));

    await waitFor(() =>
      expect(props.onSubmit).toHaveBeenCalledWith({
        name: "members",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
        ],
      }),
    );
    expect(props.onClose).toHaveBeenCalled();
  });

  it("adds and removes a column", async () => {
    const props = mount();
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "members" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column 2 name"), {
      target: { value: "name" },
    });
    fireEvent.click(screen.getByLabelText("Column 2 type"));
    fireEvent.click(screen.getByRole("option", { name: "Whole number" }));
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));

    await waitFor(() =>
      expect(props.onSubmit).toHaveBeenCalledWith({
        name: "members",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
          { name: "name", type: "INTEGER", primaryKey: false, notNull: false },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove column 2" }));
    expect(screen.queryByLabelText("Column 2 name")).not.toBeInTheDocument();
  });

  it("shows the parent's error and keeps the dialog open", async () => {
    const props = mount({
      onSubmit: vi.fn().mockRejectedValue(new Error("A table already exists.")),
    });
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "members" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));

    expect(
      await screen.findByText("A table or column with that name already exists."),
    ).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
