import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import EditUserPage from "./EditUserPage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const USERS = [
  { id: "1", username: "demouser", display_name: "Demo", role: "admin", home_drive_id: "" },
  { id: "2", username: "alex", display_name: "Alex", role: "user", home_drive_id: "d1" },
];

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
      if (u.endsWith("/api/v1/auth/me")) {
        return jsonResponse({ id: "1", username: "demouser", role: "admin", display_name: "Demo" });
      }
      if (u.endsWith("/api/v1/auth/status")) return jsonResponse({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return jsonResponse({ setup_completed: true });
      if (u.endsWith("/api/v1/users") && method === "GET") return jsonResponse(USERS);
      if (u.endsWith("/api/v1/drives")) {
        return jsonResponse([{ id: "d1", label: "Family Drive", state: "as_is" }]);
      }
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

function renderAt(id) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/settings/users/${id}`]}>
        <ThemeProvider>
          <QueryClientProvider client={client}>
            <AuthProvider>
              <Routes>
                <Route path="/settings/users/:id" element={<EditUserPage />} />
                <Route path="/settings/users" element={<div>USERS LIST</div>} />
                <Route path="/settings" element={<div>SETTINGS PAGE</div>} />
              </Routes>
            </AuthProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("EditUserPage", () => {
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

  it("is a full page with profile, role, password, folder, and remove sections", async () => {
    renderAt("2");
    expect(await screen.findByRole("heading", { name: /Edit Alex/ })).toBeInTheDocument();
    for (const title of ["Profile", "Role", "Password", "Private folder", "Remove from this Luna"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(await screen.findByText(/folder is on Family Drive/)).toBeInTheDocument();
  });

  it("saves only the fields that changed, then returns to Users", async () => {
    const user = userEvent.setup();
    renderAt("2");
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
    expect(await screen.findByText("USERS LIST")).toBeInTheDocument();
  });

  it("checks a new password and warns it signs them out", async () => {
    const user = userEvent.setup();
    renderAt("2");
    await user.type(await screen.findByLabelText(/New password/i), "hunter22hunter1");
    expect(screen.getByText(/Saving signs Alex out on every device/)).toBeInTheDocument();
    expect(screen.getByText("✓ Acceptable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeEnabled();
  });

  it("blocks an invalid username before saving", async () => {
    const user = userEvent.setup();
    renderAt("2");
    const username = await screen.findByLabelText(/Username/);
    await user.clear(username);
    await user.type(username, "a b");
    expect(screen.getByText(/Usernames are 3-32 letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("sends you to Settings to edit your own account", async () => {
    renderAt("1");
    expect(await screen.findByText("SETTINGS PAGE")).toBeInTheDocument();
  });

  it("keeps the person's files by default when removing them", async () => {
    const user = userEvent.setup();
    renderAt("2");
    await user.click(await screen.findByRole("button", { name: /^Remove Alex$/ }));
    expect(await screen.findByText(/"alex's files"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Remove$/ }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toMatch(/\/api\/v1\/users\/2\?keep_files=1$/);
    expect(await screen.findByText("USERS LIST")).toBeInTheDocument();
  });

  it("explains when the person no longer exists", async () => {
    renderAt("missing");
    expect(await screen.findByText(/This person isn't on this Luna/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Users/ })).toHaveAttribute("href", "/settings/users");
  });
});
