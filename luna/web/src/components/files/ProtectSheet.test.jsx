import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet from "./ProtectSheet";

function stubProtectApi({ drives = [], protections = [] } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = typeof url === "string" ? url : (url?.url || String(url));
    if (u.includes("/auth/me") || u.includes("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/api/v1/drives") && !u.includes("/detected") && !u.includes("/files") && !u.includes("/health")) {
      return new Response(JSON.stringify(drives), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/protections")) {
      return new Response(JSON.stringify(protections), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderSheet(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ProtectSheet driveId="d1" path="photos" onClose={() => {}} {...props} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ProtectSheet", () => {
  it("lets an admin protect a folder onto another drive", async () => {
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main" },
        { id: "d2", label: "Backup" },
      ],
      protections: [],
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: /Protect/ })).toBeInTheDocument();
    expect(screen.getByText(/copies this folder onto another drive/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Protect" })).toBeInTheDocument();
    const copyOnto = screen.getByRole("button", { name: "Copy onto" });
    expect(copyOnto.className).toMatch(/bg-primary/);
    expect(copyOnto.className).toMatch(/text-secondary/);
    expect(screen.queryByRole("button", { name: "New link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
  });

  it("explains when a second drive is missing", async () => {
    stubProtectApi({
      drives: [{ id: "d1", label: "Main" }],
      protections: [],
    });
    renderSheet();
    expect(await screen.findByText(/Needs a second drive/i)).toBeInTheDocument();
  });
});
