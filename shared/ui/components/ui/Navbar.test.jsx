import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Home } from "lucide-react";
import Navbar from "./Navbar.jsx";

afterEach(() => {
  delete document.documentElement.dataset.lunaEditor;
  window.localStorage.removeItem("lunaHamburgerPosition");
});

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar
        brand="Test"
        items={[{ to: "/", icon: Home, label: "Home", end: true }]}
        user={{ username: "admin", role: "admin" }}
        onLogout={() => {}}
        storageKey="lunaHamburgerPosition"
        editorKey="lunaEditor"
      />
    </MemoryRouter>
  );
}

async function setEditorOpen(open) {
  await act(async () => {
    if (open) {
      document.documentElement.dataset.lunaEditor = "office";
    } else {
      delete document.documentElement.dataset.lunaEditor;
    }
  });
}

describe("Navbar mobile FAB vs fullscreen editor", () => {
  it("hides the menu button while the fullscreen editor is open", async () => {
    renderNavbar();
    const fab = await screen.findByLabelText("Toggle menu");
    expect(fab).toBeInTheDocument();

    await setEditorOpen(true);
    await waitFor(() =>
      expect(screen.queryByLabelText("Toggle menu")).not.toBeInTheDocument(),
    );

    await setEditorOpen(false);
    await waitFor(() =>
      expect(screen.queryByLabelText("Toggle menu")).toBeInTheDocument(),
    );
  });

  it("keeps the button when it is parked inside the headerbar strip", async () => {
    window.localStorage.setItem(
      "lunaHamburgerPosition",
      JSON.stringify({ x: 20, y: 20 }),
    );
    renderNavbar();

    await setEditorOpen(true);
    const fab = await screen.findByLabelText("Toggle menu");
    expect(fab).toBeInTheDocument();
  });

  it("clamps drags to the headerbar strip while the editor is open", async () => {
    window.localStorage.setItem(
      "lunaHamburgerPosition",
      JSON.stringify({ x: 20, y: 20 }),
    );
    renderNavbar();

    await setEditorOpen(true);
    const fab = await screen.findByLabelText("Toggle menu");

    fireEvent.pointerDown(fab, { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
    await act(async () => {
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 400, clientY: 600 });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(fab.style.top).toBe("48px");
  });
});

describe("Navbar user menu keyboard", () => {
  function openFromKeyboard() {
    renderNavbar();
    const trigger = screen.getAllByRole("button", { name: "User menu" }).at(-1);
    return trigger;
  }

  it("keeps closed menu items out of reach", () => {
    renderNavbar();
    const menu = document.querySelector('[role="menu"]');
    expect(menu).toHaveAttribute("inert");
  });

  it("opens from ArrowDown, lands on the first item and moves with the arrows", async () => {
    const trigger = openFromKeyboard();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toHaveAttribute("inert"));
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(items.at(-1), { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items.at(-1)).toHaveFocus();
  });

  it("returns focus to the trigger on Escape", async () => {
    const trigger = openFromKeyboard();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = (await screen.findAllByRole("menuitem"))[0];
    await waitFor(() => expect(item).toHaveFocus());
    fireEvent.keyDown(item, { key: "Escape" });
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toHaveAttribute("inert"));
  });
});
