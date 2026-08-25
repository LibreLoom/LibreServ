import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SharesPage from "./SharesPage";

describe("SharesPage", () => {
  it("renders the empty Links page instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/shares")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.endsWith("/drives")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 500 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SharesPage />
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("No links yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Share something/i })).toBeInTheDocument();
    expect(screen.getByText(/they do not need a Luna account/i)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="page-lead"]')).toBeNull();
  });
});
