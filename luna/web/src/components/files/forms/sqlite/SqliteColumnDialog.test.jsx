import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SqliteColumnDialog from "./SqliteColumnDialog.jsx";

function mount(overrides = {}) {
  const props = {
    open: true,
    mode: /** @type {"add"|"rename"} */ ("add"),
    tableName: "responses",
    column: null,
    existingNames: ["id", "email"],
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<SqliteColumnDialog {...props} />);
  return { ...view, props };
}

describe("SqliteColumnDialog", () => {
  it("explains the risk and offers the SQLite types", () => {
    mount();
    expect(
      screen.getByRole("heading", { name: "Add column" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Changing columns on/)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("refuses a name that already exists", async () => {
    const { props } = mount();
    await userEvent.type(screen.getByLabelText("Column name"), "id");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(
      screen.getByText("A column with that name already exists."),
    ).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("submits a new column name and type", async () => {
    const { props } = mount();
    await userEvent.type(screen.getByLabelText("Column name"), "phone");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "TEXT");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    await waitFor(() =>
      expect(props.onSubmit).toHaveBeenCalledWith({
        name: "phone",
        type: "TEXT",
      }),
    );
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("renames without asking for a type", () => {
    mount({ mode: "rename", column: { name: "email" } });
    expect(screen.getByLabelText("Column name")).toHaveValue("email");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
