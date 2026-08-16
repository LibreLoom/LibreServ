import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import LoginPage from "./LoginPage";

describe("LoginPage", () => {
  it("logs in and shows the signed-in state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith("/auth/me")) {
        return new Response("null", { status: 401 });
      }
      if (u.endsWith("/auth/login") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }));
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>LUNA HOME</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );
    fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "hunter22hunter" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(await screen.findByText(/LUNA HOME/i)).toBeInTheDocument();
  });
});
