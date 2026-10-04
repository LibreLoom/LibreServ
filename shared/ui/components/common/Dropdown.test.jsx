import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import Dropdown from "./Dropdown.jsx";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Dropdown (value picker)", () => {
  it("opens a listbox, marks the selected option and reports a pick", () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="a" onChange={onChange} aria-label="Letter" />);
    fireEvent.click(screen.getByRole("button", { name: "Letter" }));
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(list).getByRole("option", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

function MenuHarness({ onChange = vi.fn(), options, onOpenChange, startOpen }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        outside opener
      </button>
      <Dropdown
        menu
        menuLabel="Actions"
        options={options}
        value=""
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        onChange={onChange}
        renderTrigger={({ open: isOpen, toggle, onKeyDown }) => (
          <button type="button" aria-expanded={isOpen} onClick={toggle} onKeyDown={onKeyDown}>
            Actions
          </button>
        )}
      />
    </>
  );
}

describe("Dropdown (menu mode)", () => {
  it("renders a labelled menu with headings, notes and disabled items", () => {
    render(
      <MenuHarness
        startOpen
        options={[
          { value: "folder", label: "Folder", group: "Organize" },
          { value: "text", label: "Text file", group: "Files" },
          { value: "save", label: "Save", note: "Saved just now", disabled: true, group: "Files" },
        ]}
      />,
    );
    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(within(menu).getByText("Organize")).toBeInTheDocument();
    expect(within(menu).getAllByText("Files")).toHaveLength(1);
    expect(within(menu).getByRole("menuitem", { name: /Save/ })).toBeDisabled();
    expect(within(menu).getByText("Saved just now")).toBeInTheDocument();
    expect(within(menu).queryByRole("option")).toBeNull();
  });

  it("follows a controlled open prop and reports closes", async () => {
    vi.useFakeTimers();
    try {
      const onOpenChange = vi.fn();
      render(<MenuHarness options={OPTIONS} onOpenChange={onOpenChange} />);
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "outside opener" }));
      expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Beta" }));
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens with ArrowDown on the trigger and picks with Enter, skipping disabled items", () => {
    const onChange = vi.fn();
    render(
      <MenuHarness
        onChange={onChange}
        options={[
          { value: "a", label: "Alpha", disabled: true },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
    // Landed on the first enabled item.
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("wraps around the enabled items with the arrow keys", () => {
    const onChange = vi.fn();
    render(<MenuHarness onChange={onChange} startOpen options={[...OPTIONS, { value: "c", label: "Gamma" }]} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("shows header controls and custom rows, and keepOpen rows leave the menu open", () => {
    const onChange = vi.fn();
    render(
      <Dropdown
        menu
        menuLabel="Actions"
        value=""
        onChange={onChange}
        aria-label="Open"
        menuHeader={<button type="button">Density 4</button>}
        options={[
          { value: "scan", label: "Scan", keepOpen: true, content: <span>Scanning now</span> },
          { value: "go", label: "Go" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const menu = screen.getByRole("menu", { name: "Actions" });
    // A click in the header never closes the menu or counts as a pick.
    fireEvent.click(within(menu).getByRole("button", { name: "Density 4" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Scanning now" }));
    expect(onChange).toHaveBeenCalledWith("scan");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Go" }));
    expect(onChange).toHaveBeenLastCalledWith("go");
  });
});
