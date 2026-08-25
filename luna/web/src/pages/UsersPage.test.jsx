import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import UsersPage from "./UsersPage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        return jsonResponse({ id: "admin-1", username: "plainskill", display_name: "plainskill", role: "admin" });
      }
      if (u.endsWith("/api/v1/users")) {
        return jsonResponse([
          { id: "admin-1", username: "plainskill", display_name: "plainskill", role: "admin" },
          { id: "user-2", username: "sam", display_name: "Sam", role: "user" },
        ]);
      }
      if (u.endsWith("/api/v1/drives")) return jsonResponse([]);
      if (u.endsWith("/api/v1/grants")) return jsonResponse([]);
      return jsonResponse({}, 404);
    }),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <UsersPage />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UsersPage", () => {
  it("does not offer Access on admin cards because admins already see every drive", async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText("Sam")).toBeTruthy();
    const accessButtons = screen.getAllByRole("button", { name: /^Access$/i });
    expect(accessButtons).toHaveLength(1);
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });
});
