import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";

function renderAt(path, { setupCompleted = false, hasAdmin = false } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) {
      return new Response("null", { status: 401 });
    }
    if (u.endsWith("/api/v1/auth/status")) {
      return new Response(JSON.stringify({ has_admin: hasAdmin }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
    renderAt("/", { setupCompleted: false, hasAdmin: false });
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });

  it("sends a fresh Luna from login to the setup wizard", async () => {
    renderAt("/login", { setupCompleted: false, hasAdmin: false });
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });

  it("keeps login when setup is incomplete but an account exists", async () => {
    renderAt("/login", { setupCompleted: false, hasAdmin: true });
    expect(await screen.findByText("LOGIN SCREEN")).toBeInTheDocument();
  });

  it("leaves a set-up Luna on its page", async () => {
    renderAt("/", { setupCompleted: true, hasAdmin: true });
    expect(await screen.findByText("LUNA HOME")).toBeInTheDocument();
  });
});

describe("AuthProvider session survival", () => {
  it("keeps the user signed in after login and in-app navigation", async () => {
    // /auth/me behaves like the pre-fix backend: it ALWAYS reports "not
    // signed in", even with a fresh session. The fix is that the startup
    // effect must not re-run on navigation (useNavigate's identity changes
    // per route), so the stale me read can never wipe a fresh login.
    const meCalls = { n: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        meCalls.n += 1;
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/auth/login") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));

    function LoginAndGo() {
      const { login } = useAuth();
      const navigate = useNavigate();
      return (
        <button
          onClick={() => {
            login("max", "hunter22hunter").then(() => navigate("/drives"));
          }}
        >
          LOGIN AND GO
        </button>
      );
    }

    function Drives() {
      const { user } = useAuth();
      return <div>{user ? `SIGNED IN AS ${user.username}` : "NOT SIGNED IN"}</div>;
    }

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginAndGo />} />
            <Route path="/drives" element={<Drives />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOGIN AND GO" }));
    expect(await screen.findByText("SIGNED IN AS max")).toBeInTheDocument();
    // The startup me read happens once; in-app navigation must not re-run it.
    expect(meCalls.n).toBe(1);
  });
});
