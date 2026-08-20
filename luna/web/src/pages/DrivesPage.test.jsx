import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import DrivesPage from "./DrivesPage";

function stubDrivesApi() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/drives")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/drives/detected")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  }));
}

describe("DrivesPage", () => {
  it("tells the user nothing is touched until they choose", async () => {
    stubDrivesApi();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <DrivesPage />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(screen.getAllByText(/Plug a USB drive/i).length).toBeGreaterThan(0);
  });

  it("uses a page heading for plugged-in drives, not a stacked title card", async () => {
    stubDrivesApi();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <DrivesPage />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const heading = await screen.findByRole("heading", { name: /Drives plugged in now/i, level: 2 });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-slot=card]")).toBeNull();
    expect(await screen.findByText(/Nothing new plugged in/i)).toBeInTheDocument();
  });
});
