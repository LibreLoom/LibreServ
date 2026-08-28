import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import AccessSheet from "./AccessSheet";

/**
 * @param {{
 *   role?: string,
 *   users?: any[],
 *   grants?: any[],
 *   shares?: any[],
 *   onPatch?: (url: string, body: any) => void,
 * }} [opts]
 */
function stubAccessApi({ role = "admin", users = [], grants = [], shares = [], onPatch } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
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
    if (u.includes("/grants/") && method === "PATCH") {
      onPatch?.(u, init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/grants")) {
      return new Response(JSON.stringify(grants), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/shares")) {
      return new Response(JSON.stringify(shares), { status: 200, headers: { "Content-Type": "application/json" } });
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
          <AccessSheet driveId="d1" path="photos" onClose={() => {}} {...props} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AccessSheet", () => {
  it("lets an admin grant access and make a link", async () => {
    stubAccessApi({
      users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
        { id: "3", role: "user", username: "alex", display_name: "Alex" },
      ],
      grants: [{ id: "g1", user_id: "2", drive_id: "d1", path: "photos", permission: "read" }],
      shares: [],
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: "Sharing" })).toBeInTheDocument();
    expect(await screen.findByText(/Sam/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Access for Sam/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Protect" })).not.toBeInTheDocument();
  });

  it("lets an admin switch an existing grant between Read and Write", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    stubAccessApi({
      users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
      ],
      grants: [{ id: "g1", user_id: "2", drive_id: "d1", path: "photos", permission: "read" }],
      shares: [],
      onPatch,
    });
    renderSheet();
    const trigger = await screen.findByRole("button", { name: /Access for Sam/ });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Write" }));
    await waitFor(() => expect(onPatch).toHaveBeenCalled());
    expect(onPatch.mock.calls[0][0]).toContain("/api/v1/grants/g1");
    expect(JSON.parse(onPatch.mock.calls[0][1])).toEqual({ permission: "write" });
  });

  it("hides people from a member", async () => {
    stubAccessApi({ role: "user", shares: [] });
    renderSheet();
    expect(await screen.findByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect" })).not.toBeInTheDocument();
  });

  it("links to Users when there are no people to share with", async () => {
    stubAccessApi({
      users: [{ id: "1", role: "admin", username: "admin", display_name: "Admin" }],
      grants: [],
      shares: [],
    });
    renderSheet();
    expect(
      await screen.findByText(/No people to share with yet\. Add a Member on the Users page\./),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Go to Users" });
    expect(link).toHaveAttribute("href", "/settings/users");
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
    expect(screen.queryByText("Add a person")).not.toBeInTheDocument();
  });

  it("links to Users when everyone already has access", async () => {
    stubAccessApi({
      users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
      ],
      grants: [{ id: "g1", user_id: "2", drive_id: "d1", path: "photos", permission: "read" }],
      shares: [],
    });
    renderSheet();
    expect(await screen.findByText(/Sam/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Everyone already has access\. Add more people on the Users page\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Users" })).toHaveAttribute("href", "/settings/users");
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
  });
});
