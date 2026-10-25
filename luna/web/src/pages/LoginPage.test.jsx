import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "../context/AuthContext";
import LoginPage from "./LoginPage";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { findContrastProblems } from "@libreloom/ui/test/contrast.js";

function stubFetch({ setupCompleted = true, loginOk = true } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) {
      return new Response("null", { status: 401 });
    }
    if (u.endsWith("/api/v1/auth/status")) {
      return new Response(JSON.stringify({ has_admin: true }), {
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
    if (u.endsWith("/api/v1/auth/login") && options.method === "POST") {
      if (loginOk) {
        return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "That username or password is wrong." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
}

function renderLogin() {
  return render(
    <ToastProvider>
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>LUNA HOME</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
    </ToastProvider>
  );
}

describe("LoginPage", () => {
  it("shows the Sol-style greeting", () => {
    stubFetch();
    renderLogin();
    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(screen.getByText("Sign in to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a USB recovery file" })).toHaveAttribute("href", "/recover");
  });

  it("keeps the recovery entry point visible and readable on its login panel", () => {
    stubFetch();
    renderLogin();
    const recoveryLink = screen.getByRole("link", { name: "Create a USB recovery file" });
    expect(recoveryLink).toBeVisible();
    expect(findContrastProblems(screen.getByRole("main"))).toEqual([]);
  });

  it("logs in and returns to the page the user wanted", async () => {
    stubFetch();
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "hunter22hunter" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText(/LUNA HOME/i)).toBeInTheDocument();
  });

  it("signs in on the page you were on when rendered in place", async () => {
    stubFetch();
    // Stands in for RequireAuth: no user means the sign-in form in place of
    // the page, the same URL throughout.
    function Guard() {
      const { user } = useAuth();
      return user ? <div>DRIVES PAGE</div> : <LoginPage />;
    }
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/files/d1"]}>
          <AuthProvider>
            <Routes>
              <Route path="/files/:id" element={<Guard />} />
              <Route path="/" element={<div>LUNA HOME</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    );
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "hunter22hunter" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    // Back on the page you were on — not bounced to home.
    expect(await screen.findByText("DRIVES PAGE")).toBeInTheDocument();
    expect(screen.queryByText("LUNA HOME")).not.toBeInTheDocument();
  });

  it("names each empty field and clears its message when corrected", async () => {
    stubFetch();
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText("Enter your username.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    expect(screen.queryByText("Enter your username.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
  });

  it("explains a wrong password in plain language", async () => {
    stubFetch({ loginOk: false });
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText(/username or password is wrong/i)).toBeInTheDocument();
  });

  it("asks the user to wait after too many tries, without a reset ritual", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return new Response("null", { status: 401 });
      if (u.endsWith("/api/v1/auth/status")) {
      return new Response(JSON.stringify({ has_admin: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/auth/login") && options.method === "POST") {
        return new Response(JSON.stringify({ error: "Too many tries." }), {
          status: 429, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText(/Too many tries from this device/i)).toBeInTheDocument();
    expect(screen.queryByText(/USB keyboard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/contact support/i)).not.toBeInTheDocument();
  });
});
