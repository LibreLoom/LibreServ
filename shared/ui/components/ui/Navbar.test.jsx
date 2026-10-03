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
