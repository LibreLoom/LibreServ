import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShortcutsProvider, useShortcut } from "./ShortcutsContext.jsx";

function Bind({ keys, handler, ...options }) {
  useShortcut(keys, handler, { label: "Do a thing", ...options });
  return null;
}

function press(init, target = document.body) {
  fireEvent.keyDown(target, init);
}

describe("ShortcutsProvider", () => {
  it("runs a registered shortcut and stops after unmount", () => {
    const handler = vi.fn();
    const { rerender } = render(
      <ShortcutsProvider><Bind keys="n" handler={handler} /></ShortcutsProvider>,
    );
    press({ key: "n" });
    expect(handler).toHaveBeenCalledTimes(1);
    rerender(<ShortcutsProvider />);
    press({ key: "n" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not fire bare keys while typing, but fires Alt combos", () => {
    const bare = vi.fn();
    const alt = vi.fn();
    render(
      <ShortcutsProvider>
        <Bind keys="n" handler={bare} />
        <Bind keys="Alt+/" handler={alt} />
        <input aria-label="Name" />
      </ShortcutsProvider>,
    );
    const input = screen.getByLabelText("Name");
    press({ key: "n" }, input);
    press({ key: "/", code: "Slash", altKey: true }, input);
    expect(bare).not.toHaveBeenCalled();
    expect(alt).toHaveBeenCalledTimes(1);
  });

  it("lets the higher priority win, and falls through when it returns false", () => {
    const global = vi.fn();
    const local = vi.fn(() => false);
    render(
      <ShortcutsProvider>
        <Bind keys="/" handler={global} />
        <Bind keys="/" handler={local} priority={1} />
      </ShortcutsProvider>,
    );
    press({ key: "/" });
    expect(local).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while a dialog is open unless allowed", () => {
    const handler = vi.fn();
    render(
      <ShortcutsProvider>
        <Bind keys="n" handler={handler} />
        <div role="dialog" aria-modal="true" />
      </ShortcutsProvider>,
    );
    press({ key: "n" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not treat Enter as a shortcut on a focused button", () => {
    const handler = vi.fn();
    render(
      <ShortcutsProvider>
        <Bind keys="Enter" handler={handler} />
        <button>Go</button>
      </ShortcutsProvider>,
    );
    press({ key: "Enter" }, screen.getByText("Go"));
    expect(handler).not.toHaveBeenCalled();
    press({ key: "Enter" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores a held key unless repeat is on", () => {
    const handler = vi.fn();
    render(<ShortcutsProvider><Bind keys="n" handler={handler} /></ShortcutsProvider>);
    press({ key: "n", repeat: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("opens a sheet with ? that lists only the winning label for a shared key", async () => {
    render(
      <ShortcutsProvider>
        <Bind keys="/" handler={() => {}} label="Search all your files" group="Search" />
        <Bind keys="/" handler={() => {}} label="Search this folder" group="Search" priority={1} />
        <Bind keys="Alt+/" handler={() => {}} label="Search all your files" group="Search" />
      </ShortcutsProvider>,
    );
    press({ key: "?", shiftKey: true });
    expect(await screen.findByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Search this folder")).toBeInTheDocument();
    // "/" now belongs to the folder search, so the all-files row only shows Alt+/.
    const row = screen.getByText("Search all your files").closest("li");
    expect(row).toHaveTextContent("Alt");
    expect(row).not.toHaveTextContent("or");
  });

  it("does nothing without a provider", () => {
    const handler = vi.fn();
    render(<Bind keys="n" handler={handler} />);
    press({ key: "n" });
    expect(handler).not.toHaveBeenCalled();
  });
});
