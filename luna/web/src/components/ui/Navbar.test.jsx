import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import Navbar from "./Navbar";

afterEach(() => {
  delete document.documentElement.dataset.lunaEditor;
  window.localStorage.removeItem("lunaHamburgerPosition");
  vi.unstubAllGlobals();
});

function stubAuthApi() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/setup") || u.endsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderNavbar() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Navbar />
      </AuthProvider>
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
    stubAuthApi();
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
    stubAuthApi();
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
    stubAuthApi();
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
