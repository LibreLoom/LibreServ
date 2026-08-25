import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import ProtectionPage from "./ProtectionPage";

describe("ProtectionPage", () => {
  it("renders the protect page instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/protections")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.endsWith("/drives")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 500 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ProtectionPage />
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("Nothing protected yet")).toBeInTheDocument();
    expect(screen.getByText("A free second copy")).toBeInTheDocument();
    expect(screen.getByText(/If you delete a file by accident, the copy stays/i)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="page-lead"]')).toBeNull();
  });
});
