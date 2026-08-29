import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NewItemMenu from "./NewItemMenu.jsx";

describe("NewItemMenu", () => {
  it("opens a New menu with folder and text file", async () => {
    const onPick = vi.fn();
    render(<NewItemMenu onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(await screen.findByRole("menuitem", { name: "Folder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Text file" })).toBeInTheDocument();
    expect(screen.getByText("Organize")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Text file" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "text" }));
  });

  it("skips the menu when only one kind is offered", () => {
    const onPick = vi.fn();
    render(<NewItemMenu ids={["folder"]} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "folder" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
