import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import AccessCategory from "./AccessCategory.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import { AuthProvider, useAuth } from "../../../context/AuthContext.jsx";
import LoginPage from "../../../pages/LoginPage.jsx";

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
    if (u.includes("/auth/revoke-devices") && method === "POST") {
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
    <ToastProvider>
    <QueryClientProvider client={client}>
      <AccessCategory />
    </QueryClientProvider>
    </ToastProvider>,
  );
}

function AuthenticatedAccess() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <AccessCategory /> : <LoginPage />;
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
    expect(screen.getByRole("button", { name: /Sign out of Luna in every browser/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke app access/i })).toBeNull();
    expect(screen.queryByText(/Luna cannot show a list of every browser/i)).toBeNull();
  });

  it("asks before signing out every app", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    await user.click(await screen.findByRole("button", { name: "Sign out all apps" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out all apps?" });
    expect(within(dialog).getByText(/All app and access tokens will stop working right away/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const callsAfterCancel = /** @type {any} */ (fetch).mock.calls;
    expect(callsAfterCancel.some(([u, init]) => (
      String(u).includes("/auth/revoke-devices") && init?.method === "POST"
    ))).toBe(false);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign out all apps?" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Sign out all apps" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Sign out all apps?" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Sign out all apps" }));
    await waitFor(() => {
      const calls = /** @type {any} */ (fetch).mock.calls;
      expect(calls.some(([u, init]) => String(u).includes("/auth/revoke-devices") && init?.method === "POST")).toBe(true);
    });
  });

  it("shows apps and access tokens section", async () => {
    renderAccess();
    expect(await screen.findByRole("heading", { name: "Apps and access tokens" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New access token/i })).toBeTruthy();
    expect(screen.getByText(/phone app, Luna Desktop, or script/i)).toBeTruthy();
  });

  it("lists existing tokens with revoke-token action", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke token/i })).toBeTruthy();
  });

  it("shows a retry after the access token list fails to load", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    let fail = true;
    const baseFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes("/device-tokens") && (init?.method || "GET") === "GET" && fail) {
        return new Response(JSON.stringify({ error: "Injected 500" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return baseFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = (await import("@testing-library/user-event")).default.setup();
    renderAccess();

    expect(await screen.findByText("Couldn't load access tokens. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("No apps or access tokens are set up yet.")).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Kitchen Mac")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/device-tokens"))).toHaveLength(2);
  });

  it("opens token creation in a modal from the token list", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();
    expect(screen.queryByLabelText(/Name this app/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /New access token/i }));
    const dialog = await screen.findByRole("dialog", { name: /New access token/i });
    const input = /** @type {HTMLInputElement} */ (within(dialog).getByLabelText(/Name this app/i));
    await waitFor(() => expect(input).toHaveFocus());
    expect(within(dialog).getByText("Give this device a name between 1 and 80 characters.")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("maxLength");
    expect(within(dialog).getByRole("button", { name: /Create access token/i })).toBeDisabled();
    await user.type(input, "a".repeat(81));
    expect(input).toHaveValue("a".repeat(80));
    fireEvent.change(input, { target: { value: "😀".repeat(81) } });
    expect(input).toHaveValue("😀".repeat(80));
    expect(within(dialog).getByRole("button", { name: /Create access token/i })).toBeEnabled();
  });

  it("shows the password-change notice after the real profile form ends the session", async () => {
    const json = (value) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith("/api/v1/auth/me") && init.method === "PATCH") {
        return json({ ok: true, signed_out: true, message: "Password changed." });
      }
      if (path.endsWith("/api/v1/auth/me")) {
        return json({ id: "u1", username: "max", display_name: "Max", role: "admin" });
      }
      if (path.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (path.endsWith("/api/v1/setup")) return json({ setup_completed: true });
      if (path.endsWith("/api/v1/device-tokens")) return json([]);
      return new Response("Not found", { status: 404 });
    }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/settings"]}>
            <AuthProvider>
              <AuthenticatedAccess />
              <Toaster />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );

    await user.type(await screen.findByLabelText("Current password"), "correct");
    await user.type(screen.getByLabelText("New password"), "New-luna-password-2026!");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Password changed. Sign in again with your new password.")).toBeInTheDocument();
    expect(screen.getByText("Sign in to continue.")).toBeInTheDocument();
  });

  it("token list items animate height on expand/collapse", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    const { container } = renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();

    const item = container.querySelector("ul.divide-y > li");
    expect(item).toBeTruthy();
    expect(item.className).toMatch(/transition-\[height\]/);
    expect(item.className).toMatch(/overflow-hidden/);
    expect(/** @type {HTMLElement} */ (item).style.transitionDuration).toBe("var(--motion-duration-medium2)");
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
    expect(screen.getByRole("button", { name: /Hide usage log/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke token/i })).toBeTruthy();
    expect(usageCalls).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Hide usage log/i }));
    expect(screen.queryByText(/list — Photos/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Usage log/i })).toBeTruthy();
  });

  it("displays client app and origin in usage log", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/device-tokens/") && u.includes("/usage") && method === "GET") {
        return new Response(JSON.stringify([{
          action: "WebDAV folder",
          detail: "Browsed folder",
          client: "macOS Finder",
          origin: "Home network (192.168.1.50)",
          used_at: Math.floor(Date.now() / 1000),
        }]), {
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
    expect(await screen.findByText(/WebDAV folder — Browsed folder/i)).toBeTruthy();
    expect(screen.getByText("macOS Finder")).toBeTruthy();
    expect(screen.getByText("Home network (192.168.1.50)")).toBeTruthy();
  });

  it("offers a QR code after creating an access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/device-tokens") && method === "POST") {
        return new Response(JSON.stringify({ id: "t2", token: "secret-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/device-tokens") && method === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));

    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    await user.click(await screen.findByRole("button", { name: /New access token/i }));
    await user.type(await screen.findByLabelText(/Name this app/i), "Sam's phone");
    await user.click(screen.getByRole("button", { name: /Create access token/i }));

    expect(await screen.findByRole("button", { name: /Show as QR code/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Show as QR code/i }));
    expect(await screen.findByRole("heading", { name: /Show as QR code/i })).toBeTruthy();
    expect(screen.getByText(/tap Scan QR code/i)).toBeTruthy();
  });
});
