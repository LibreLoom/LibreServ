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

  it("lists existing tokens with revoke-token action", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke token/i })).toBeTruthy();
  });

  it("shows create wizard above existing token list", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();

    const wizardHeading = screen.getByText("Add a new access token");
    const listHeading = screen.getByText("Your access tokens");
    const tokenName = screen.getByText("Kitchen Mac");

    expect(wizardHeading.compareDocumentPosition(listHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listHeading.compareDocumentPosition(tokenName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("token list items use contrasting text on primary surface", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    const { container } = renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();

    const item = container.querySelector("li.bg-primary.text-secondary");
    expect(item).toBeTruthy();
    // Children must inherit text-secondary — text-primary on bg-primary is invisible in dark mode.
    expect(item.querySelector(".text-primary")).toBeNull();
    expect(screen.getByText("Kitchen Mac").className).not.toMatch(/text-primary/);
  });

  it("token list items animate height on expand/collapse", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    const { container } = renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();

    const item = container.querySelector("li.bg-primary.text-secondary");
    expect(item).toBeTruthy();
    expect(item.className).toMatch(/transition-\[height\]/);
    expect(item.className).toMatch(/overflow-hidden/);
    expect(item.style.transitionDuration).toBe("var(--motion-duration-medium2)");
    // Measured-height pattern: outer clip + inner content wrapper
    expect(item.children.length).toBe(1);
  });

  it("toggles usage log without removing revoke", async () => {
    let usageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/device-tokens/") && u.includes("/usage") && method === "GET") {
        usageCalls += 1;
        return new Response(JSON.stringify([{ action: "list", detail: "Photos", used_at: 1 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/device-tokens") && method === "GET") {
        return new Response(JSON.stringify([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));

    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Usage log/i }));
    expect(await screen.findByText(/list — Photos/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hide log/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke token/i })).toBeTruthy();
    expect(usageCalls).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Hide log/i }));
    expect(screen.queryByText(/list — Photos/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Usage log/i })).toBeTruthy();
  });
});
