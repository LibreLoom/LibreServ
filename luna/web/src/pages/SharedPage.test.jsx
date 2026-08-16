import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SharedPage from "./SharedPage";

describe("SharedPage", () => {
  it("shows the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><SharedPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(/Nothing has been shared with you yet/i)).toBeInTheDocument();
  });
});
