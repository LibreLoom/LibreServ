import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./AuthContext";

function renderAt(path, setupCompleted) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) {
      return new Response("null", { status: 401 });
    }
    if (u.endsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ name: "Luna", setup_completed: setupCompleted }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<div>LUNA HOME</div>} />
          <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AuthProvider setup gating", () => {
  it("sends a fresh Luna to the setup wizard", async () => {
    renderAt("/", false);
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });

  it("keeps a fresh Luna on the login screen", async () => {
    renderAt("/login", false);
    expect(await screen.findByText("LOGIN SCREEN")).toBeInTheDocument();
  });

  it("leaves a set-up Luna on its page", async () => {
    renderAt("/", true);
    expect(await screen.findByText("LUNA HOME")).toBeInTheDocument();
  });
});
