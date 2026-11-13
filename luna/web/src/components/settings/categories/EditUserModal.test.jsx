import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import EditUserModal from "./EditUserModal.jsx";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALEX = { id: "2", username: "alex", display_name: "Alex", role: "user" };

let patches;
let deletes;

function stubFetch() {
  patches = [];
  deletes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.endsWith("/private-count")) return jsonResponse({ count: 2 });
      if (u.includes("/api/v1/users/") && method === "DELETE") {
        deletes.push(u);
        return jsonResponse({ ok: true });
      }
      if (u.includes("/api/v1/users/") && method === "PATCH") {
        patches.push({ url: u, body: JSON.parse(init.body) });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <EditUserModal target={ALEX} onClose={onClose} />
      </QueryClientProvider>
    </ToastProvider>,
  );
  return onClose;
}

describe("EditUserModal", () => {
  beforeEach(() => {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens as a modal with profile, role, password and remove sections", async () => {
    renderModal();
    expect(await screen.findByRole("heading", { name: /Edit Alex/ })).toBeInTheDocument();
    for (const title of ["Profile", "Role", "Password", "Remove from this Luna"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it("saves only the fields that changed, then closes", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    const username = await screen.findByLabelText(/Username/);
    const save = screen.getByRole("button", { name: /Save changes/ });
    expect(save).toBeDisabled();

    await user.clear(username);
    await user.type(username, "alex.k");
    expect(screen.getByText(/sign in as "alex.k" from now on/)).toBeInTheDocument();
    await user.click(save);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].url).toMatch(/\/api\/v1\/users\/2$/);
    expect(patches[0].body).toEqual({ username: "alex.k" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("checks a new password and warns it signs them out", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByLabelText(/New password/i), "hunter22hunter1");
    expect(screen.getByText(/Saving signs Alex out on every device/)).toBeInTheDocument();
    expect(screen.getByText("✓ Acceptable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeEnabled();
  });

  it("blocks an invalid username before saving", async () => {
    const user = userEvent.setup();
    renderModal();
    const username = await screen.findByLabelText(/Username/);
    await user.clear(username);
    await user.type(username, "a b");
    expect(screen.getByText(/Usernames are 3-32 letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("asks before removing someone, then closes", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    await user.click(await screen.findByRole("button", { name: /^Remove Alex$/ }));
    expect(await screen.findByText(/Their 2 private folders stay on the drives/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Remove$/ }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toMatch(/\/api\/v1\/users\/2$/);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
