import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SqliteRenameTableDialog from "./SqliteRenameTableDialog.jsx";

function mount(overrides = {}) {
  const props = {
    open: true,
    tableName: "responses",
    existingNames: ["responses", "members"],
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<SqliteRenameTableDialog {...props} />);
  return { ...view, props };
}

describe("SqliteRenameTableDialog", () => {
  it("starts with the current name and explains the risk", () => {
    mount();
    expect(
      screen.getByRole("heading", { name: "Rename table" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Table name")).toHaveValue("responses");
    expect(
      screen.getByText(/can break forms that use this table/i),
    ).toBeInTheDocument();
  });

  it("refuses a name that already exists", async () => {
    const { props } = mount();
    const input = screen.getByLabelText("Table name");
    await userEvent.clear(input);
    await userEvent.type(input, "members");
    await userEvent.click(screen.getByRole("button", { name: "Rename table" }));
    expect(
      screen.getByText("A table with that name already exists."),
    ).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("submits a new name", async () => {
    const { props } = mount();
    const input = screen.getByLabelText("Table name");
    await userEvent.clear(input);
    await userEvent.type(input, "gatherings");
    await userEvent.click(screen.getByRole("button", { name: "Rename table" }));
    await waitFor(() =>
      expect(props.onSubmit).toHaveBeenCalledWith("gatherings"),
    );
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("closes without writing when the name is unchanged", async () => {
    const { props } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Rename table" }));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });
});
