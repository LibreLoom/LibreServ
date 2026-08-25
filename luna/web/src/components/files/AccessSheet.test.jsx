import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import AccessSheet from "./AccessSheet";

function stubAccessApi({ role = "admin", users = [], grants = [], shares = [], drives = [], protections = [] } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role, username: "admin" }), {
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
    if (u.endsWith("/users")) {
      return new Response(JSON.stringify(users), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/grants")) {
      return new Response(JSON.stringify(grants), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/shares")) {
      return new Response(JSON.stringify(shares), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify(drives), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/protections")) {
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
          <AccessSheet driveId="d1" path="photos" kind="folder" onClose={() => {}} {...props} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AccessSheet", () => {
  it("lets an admin grant access, make a link, and protect a folder", async () => {
    stubAccessApi({
      users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
      ],
      grants: [{ id: "g1", user_id: "2", drive_id: "d1", path: "photos", permission: "read" }],
      shares: [],
      drives: [
        { id: "d1", label: "Main" },
        { id: "d2", label: "Backup" },
      ],
      protections: [],
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: "Sharing" })).toBeInTheDocument();
    expect(await screen.findByText(/Sam/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Protect" })).toBeInTheDocument();
  });

  it("hides people and protect from a household member", async () => {
    stubAccessApi({ role: "user", shares: [] });
    renderSheet();
    expect(await screen.findByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect" })).not.toBeInTheDocument();
  });
});
