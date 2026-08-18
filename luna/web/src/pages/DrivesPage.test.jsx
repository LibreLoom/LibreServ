import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import DrivesPage from "./DrivesPage";

describe("DrivesPage", () => {
  it("tells the user nothing is touched until they choose", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/drives")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (String(url).endsWith("/drives/detected")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 500 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AuthProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter><DrivesPage /></MemoryRouter>
        </QueryClientProvider>
      </AuthProvider>
    );
    expect(screen.getAllByText(/Plug a USB drive/i).length).toBeGreaterThan(0);
  });
});
