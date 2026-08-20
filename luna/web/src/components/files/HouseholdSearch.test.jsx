import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import HouseholdSearch from "./HouseholdSearch";

function renderSearch(hits) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/search")) {
      return new Response(JSON.stringify(hits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HouseholdSearch />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("HouseholdSearch", () => {
  it("explains an empty search in plain language", async () => {
    renderSearch([]);
    fireEvent.change(screen.getByLabelText("Find a file by name"), { target: { value: "zz" } });
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.getByText(/only shows files you're allowed to see/i)).toBeInTheDocument();
  });

  it("links a hit to its folder", async () => {
    renderSearch([{ drive_id: "d1", path: "album/beach.jpg", name: "beach.jpg" }]);
    fireEvent.change(screen.getByLabelText("Find a file by name"), { target: { value: "beach" } });
    const link = await screen.findByRole("link", { name: /beach.jpg/i });
    expect(link).toHaveAttribute("href", "/drives/d1?path=album");
  });
});
