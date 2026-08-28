import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import UsersPage from "./UsersPage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch({
  role = "admin",
  users = [
    { id: "1", username: "demouser", display_name: "Demo", role: "admin" },
    { id: "2", username: "alex", display_name: "Alex", role: "user" },
  ],
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
        return jsonResponse({ id: "1", username: "demouser", role, display_name: "Demo" });
      }
      if (u.endsWith("/api/v1/users") && (!init || !init.method || init.method === "GET")) {
        return jsonResponse(users);
      }
      if (u.includes("/api/v1/users/") && init?.method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      if (u.endsWith("/api/v1/users") && init?.method === "POST") {
        return jsonResponse({ id: "3", username: "new", display_name: "New", role: "user" });
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <UsersPage />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("UsersPage", () => {
  beforeEach(() => {
    window.matchMedia = (query) => ({
      matches: String(query).includes("min-width: 768px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders users in a table list, not a card grid", async () => {
    stubFetch();
    const { container } = renderPage();

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(container.querySelector(".md\\:grid-cols-2")).toBeNull();

    const list = await screen.findByRole("region", { name: /User list/i });
    expect(within(list).getByText("Demo")).toBeTruthy();
    expect(within(list).getByText("demouser")).toBeTruthy();
    expect(within(list).getByText("Admin")).toBeTruthy();
    expect(within(list).getByText("Member")).toBeTruthy();
    expect(within(list).getByText("Alex")).toBeTruthy();
  });

  it("keeps Admin InfoHint plain-language copy", async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByLabelText(/What Admin means/i)).toBeTruthy();
  });

  it("asks before removing a user", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();

    const remove = await screen.findByRole("button", { name: /Remove Alex/i });
    await user.click(remove);

    expect(await screen.findByRole("heading", { name: /Remove user/i })).toBeTruthy();
    expect(screen.getByText(/Remove "Alex" from this Luna/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/users/2"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("blocks non-admins from managing users", async () => {
    stubFetch({ role: "user", users: [] });
    renderPage();

    expect(
      await screen.findByText(/This page is for admins/i),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("enforces the 12+ letter/number password policy in Add a user", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();

    // Header trigger is icon-only (LibreServ-style big plus) with aria-label.
    await user.click(await screen.findByRole("button", { name: /^Add user$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /Add a user/i })).toBeTruthy();

    const password = within(dialog).getByPlaceholderText(/At least 12 characters/i);
    const addBtn = within(dialog).getByRole("button", { name: /^Add user$/i });

    await user.type(within(dialog).getByPlaceholderText(/Username/i), "jamie");
    await user.type(password, "short1");
    expect(within(dialog).getByText(/Passwords need at least 12 characters/i)).toBeTruthy();
    expect(addBtn).toBeDisabled();

    await user.clear(password);
    await user.type(password, "abcdefghijkl");
    expect(within(dialog).getByText(/Passwords need at least one letter and one number/i)).toBeTruthy();
    expect(addBtn).toBeDisabled();

    await user.clear(password);
    await user.type(password, "hunter22hunter1");
    expect(within(dialog).queryByText(/Passwords need at least/i)).toBeNull();
    expect(addBtn).not.toBeDisabled();

    await user.click(addBtn);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users$/),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"password":"hunter22hunter1"'),
      }),
    );
  });

  it("shows a big plus add-user control in the header, not an Add user chip", async () => {
    stubFetch();
    renderPage();

    const add = await screen.findByRole("button", { name: /^Add user$/i });
    expect(add.textContent?.trim()).toBe("");
    expect(within(add).queryByText(/Add user/i)).toBeNull();
  });
});
