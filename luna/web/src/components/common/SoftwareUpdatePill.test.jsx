import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext.jsx";
import SoftwareUpdatePill from "./SoftwareUpdatePill.jsx";

vi.mock("../../hooks/useSoftwareUpdates.jsx", () => ({
  useSoftwareUpdates: vi.fn(),
}));

import { useSoftwareUpdates } from "../../hooks/useSoftwareUpdates.jsx";

function renderPill() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me")) {
      return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/auth/status")) {
      return new Response(JSON.stringify({ has_admin: true, connect_active: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/api/v1/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <SoftwareUpdatePill />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("SoftwareUpdatePill", () => {
  beforeEach(() => {
    vi.mocked(useSoftwareUpdates).mockReturnValue({
      data: { update_available: false },
      isLoading: false,
      error: null,
    });
  });

  it("renders nothing when up to date", () => {
    const { container } = renderPill();
    expect(container.querySelector('[data-slot="software-update-pill"]')).toBeNull();
  });

  it("shows the update version when an update is available", () => {
    vi.mocked(useSoftwareUpdates).mockReturnValue({
      data: { update_available: true, latest_version: "luna-v0.2.0" },
      isLoading: false,
      error: null,
    });
    renderPill();
    expect(screen.getByText("luna-v0.2.0 ready")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings#about");
  });
});
