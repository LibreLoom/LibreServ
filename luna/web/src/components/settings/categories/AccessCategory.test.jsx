import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccessCategory from "./AccessCategory.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

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

  it("signs out every app through revoke-devices", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    await user.click(await screen.findByRole("button", { name: "Sign out all apps" }));
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

  it("opens token creation in a modal from the token list", async () => {
    stubFetch([{ id: "t1", name: "Kitchen Mac", last_used_at: null }]);
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAccess();
    expect(await screen.findByText("Kitchen Mac")).toBeTruthy();
    expect(screen.queryByLabelText(/Name this app/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /New access token/i }));
    const dialog = await screen.findByRole("dialog", { name: /New access token/i });
    const input = within(dialog).getByLabelText(/Name this app/i);
    await waitFor(() => expect(input).toHaveFocus());
    // The button stays active so Luna's own rule (1-80 characters) is shown
    // inline when the name is blank, instead of silently doing nothing.
    expect(within(dialog).getByRole("button", { name: /Create access token/i })).toBeEnabled();
  });

  it("shows Luna's name rule when creation is submitted with a blank name", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/device-tokens") && method === "POST") {
        return new Response(JSON.stringify({ error: "Give this access token a name between 1 and 80 characters." }), {
          status: 400,
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
    const dialog = await screen.findByRole("dialog", { name: /New access token/i });
    await user.click(within(dialog).getByRole("button", { name: /Create access token/i }));
    expect(
      await within(dialog).findByText("Give this access token a name between 1 and 80 characters."),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Create access token/i })).toBeTruthy();
  });

  it("shows a friendly error with a retry when tokens cannot load", async () => {
    let failLoad = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/device-tokens")) {
        if (failLoad) return new Response(JSON.stringify({ error: "Injected 500" }), { status: 500, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }));
    const { userEvent } = await import("@testing-library/user-event");
    renderAccess();
    expect(await screen.findByText(/Luna couldn't load your access tokens right now/i)).toBeTruthy();
    expect(screen.queryByText(/No apps or access tokens are set up yet/i)).toBeNull();
    failLoad = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No apps or access tokens are set up yet/i)).toBeTruthy();
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
    expect(await screen.findByText(/list: Photos/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hide usage log/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke token/i })).toBeTruthy();
    expect(usageCalls).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Hide usage log/i }));
    expect(screen.queryByText(/list: Photos/i)).toBeNull();
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
    expect(await screen.findByText(/WebDAV folder: Browsed folder/i)).toBeTruthy();
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

describe("AccessCategory password-change errors", () => {
  const jsonError = (body, status) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function renderWithPatch(patchResponse) {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/auth/me") && init?.method === "PATCH") return patchResponse;
      if (u.includes("/device-tokens") && (!init?.method || init.method === "GET")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }));
    renderAccess();
  }

  async function changePassword() {
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "brand-new-pass-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  }

  afterEach(() => vi.unstubAllGlobals());

  it("keeps a real wrong-current-password refusal under Current password", async () => {
    renderWithPatch(jsonError({ error: "That's not your current password." }, 403));
    await changePassword();
    expect(await screen.findByText("That's not your current password.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById("profile-current-password-error")).toBeTruthy();
    expect(document.querySelector('[data-slot="page-notice"]')).toBeNull();
  });

  it("puts an expired-page 403 in a form notice, not on Current password", async () => {
    renderWithPatch(jsonError({ error: "This page expired. Refresh and try again.", code: "page_expired" }, 403));
    await changePassword();
    expect(await screen.findByText("This page expired. Refresh and try again.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "false");
    expect(document.getElementById("profile-current-password-error")).toBeNull();
    expect(document.querySelector('[data-slot="page-notice"]')).toBeTruthy();
  });

  it("puts a rate-limit failure in a form notice, not on New password", async () => {
    renderWithPatch(jsonError({ error: "Too many tries. Wait a moment, then try again." }, 429));
    await changePassword();
    expect(await screen.findByText("Too many tries. Wait a moment, then try again.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "false");
    expect(document.getElementById("profile-current-password-error")).toBeNull();
    expect(document.querySelector('[data-slot="page-notice"]')).toBeTruthy();
  });

  it("puts a 400 password-policy refusal under New password, not in a form notice", async () => {
    renderWithPatch(jsonError({ error: "Passwords need at least one letter and one number." }, 400));
    await changePassword();
    expect(await screen.findByText("Passwords need at least one letter and one number.")).toBeTruthy();
    expect(document.getElementById("profile-new-password-error")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "false");
    expect(document.querySelector('[data-slot="page-notice"]')).toBeNull();
  });

  it("puts a 400 breach-service refusal under New password", async () => {
    renderWithPatch(jsonError({
      error: "That password is in known data breaches, so it is not safe. Choose a different password.",
    }, 400));
    await changePassword();
    expect(await screen.findByText(/That password is in known data breaches/)).toBeTruthy();
    expect(document.getElementById("profile-new-password-error")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector('[data-slot="page-notice"]')).toBeNull();
  });

  it("keeps an unrelated 400 in a form notice, not on New password", async () => {
    // Only lunad's policy/breach 400s belong on the field. A generic 400 must
    // not go back to the old behaviour where every error hit New password.
    renderWithPatch(jsonError({ error: "Names are 1-80 characters." }, 400));
    await changePassword();
    expect(await screen.findByText("Names are 1-80 characters.")).toBeTruthy();
    expect(document.getElementById("profile-new-password-error")).toBeNull();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "false");
    expect(document.querySelector('[data-slot="page-notice"]')).toBeTruthy();
  });
});
