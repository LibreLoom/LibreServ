import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import LandingPage from "./LandingPage";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}

describe("LandingPage", () => {
  it("speaks the Luna promise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    renderPage();
    expect(screen.getAllByRole("heading", { name: "Luna" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No subscription — ever/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Plug in a USB drive/i).length).toBeGreaterThan(0);
  });
});
