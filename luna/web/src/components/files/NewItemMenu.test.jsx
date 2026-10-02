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

  it("hides the Private group by default", async () => {
    render(<NewItemMenu onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("menuitem", { name: "Folder" });
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Private folder" })).not.toBeInTheDocument();
  });

  it("lists Private folder under Organize when private folders are allowed (everyone but link guests)", async () => {
    const onPick = vi.fn();
    render(<NewItemMenu onPick={onPick} allowPrivate />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.slice(0, 2).map((item) => item.textContent)).toEqual(["Folder", "Private folder"]);
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Private folder" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "private-folder", private: true }));
  });

  it("never adds Private to a folder-only picker", () => {
    render(<NewItemMenu ids={["folder"]} allowPrivate onPick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });
});
