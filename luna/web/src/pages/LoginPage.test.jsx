import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import LoginPage from "./LoginPage";

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
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>LUNA HOME</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  it("shows the LibreServ-style greeting", () => {
    stubFetch();
    renderLogin();
    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(screen.getByText("Hey there! Log in to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
  });

  it("logs in and returns to the page the user wanted", async () => {
    stubFetch();
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "hunter22hunter" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText(/LUNA HOME/i)).toBeInTheDocument();
  });

  it("explains a wrong password in plain language", async () => {
    stubFetch({ loginOk: false });
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username", { selector: "input" }), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByText(/username or password might be incorrect/i)).toBeInTheDocument();
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
