import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import useDialogFocus from "./useDialogFocus.js";

function Harness() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef(null);
  return (
    <div id="root">
      <button type="button" onClick={() => setOpen(true)}>
        Open photo
      </button>
      {open ? <Dialog dialogRef={dialogRef} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function Dialog({ dialogRef, onClose }) {
  // Rendered inside #root here; the hook leaves #root alone in that case,
  // so the inert test below mounts the dialog outside it.
  useDialogFocus(dialogRef);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Photo">
      <button type="button">First</button>
      <button type="button" onClick={onClose}>
        Last
      </button>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("moves focus in, traps Tab, and gives focus back to the opener", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open photo" });
    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.click(last);
    expect(opener).toHaveFocus();
  });

  it("makes the app root inert while a dialog outside it is open", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    function Outside() {
      const ref = useRef(null);
      useDialogFocus(ref);
      return (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Photo">
          <button type="button">Only</button>
        </div>
      );
    }
    const { unmount } = render(<Outside />);
    expect(root).toHaveAttribute("inert");
    unmount();
    expect(root).not.toHaveAttribute("inert");
    root.remove();
  });
});
