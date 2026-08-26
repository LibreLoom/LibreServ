import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccessCategory from "./AccessCategory.jsx";

function stubFetch(tokens = []) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/device-tokens") && method === "GET") {
      return new Response(JSON.stringify(tokens), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/auth/revoke-sessions") && method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
}

function renderAccess() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccessCategory />
    </QueryClientProvider>,
  );
}

describe("AccessCategory", () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows browser sign-out without bulk app revoke", async () => {
    renderAccess();
    expect(await screen.findByRole("heading", { name: "Browsers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign out every browser/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke app access/i })).toBeNull();
    expect(screen.getByText(/Luna cannot show a list of every browser/i)).toBeTruthy();
  });

  it("shows apps and access tokens section", async () => {
    renderAccess();
    expect(await screen.findByRole("heading", { name: "Apps and access tokens" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.getByText(/phone app, desktop app, or script/i)).toBeTruthy();
  });

  it("lists existing tokens with stop-this-app action", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop this app/i })).toBeTruthy();
  });
});
