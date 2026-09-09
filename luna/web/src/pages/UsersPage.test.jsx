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

  it("renders users in a table list on desktop, not a card grid", async () => {
    stubFetch();
    const { container } = renderPage();

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("list", { name: /Rows/i })).toBeNull();
    expect(container.querySelector(".md\\:grid-cols-2")).toBeNull();

    const list = await screen.findByRole("region", { name: /User list/i });
    expect(within(list).getByText("Demo")).toBeTruthy();
    expect(within(list).getByText("demouser")).toBeTruthy();
    expect(within(list).getByText("Admin")).toBeTruthy();
    expect(within(list).getByText("Member")).toBeTruthy();
    expect(within(list).getByText("Alex")).toBeTruthy();
  });

  it("renders each user as a vertical card on mobile", async () => {
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
    renderPage();

    expect(screen.queryByRole("table")).toBeNull();
    const cards = await screen.findByRole("list", { name: /Rows/i });
    const articles = within(cards).getAllByRole("article");
    expect(articles).toHaveLength(2);

    expect(within(articles[0]).getByText("Name")).toBeTruthy();
    expect(within(articles[0]).getByText("Demo")).toBeTruthy();
    expect(within(articles[0]).getByText("Username")).toBeTruthy();
    expect(within(articles[0]).getByText("demouser")).toBeTruthy();
    expect(within(articles[0]).getByText("Role")).toBeTruthy();
    expect(within(articles[0]).getByText("Admin")).toBeTruthy();
    expect(within(articles[0]).getByLabelText(/What Admin means/i)).toBeTruthy();

    expect(within(articles[1]).getByText("Alex")).toBeTruthy();
    expect(within(articles[1]).getByText("Member")).toBeTruthy();
    expect(within(articles[1]).getByLabelText(/What Member means/i)).toBeTruthy();
    expect(within(articles[1]).getByRole("button", { name: /Remove Alex/i })).toBeTruthy();
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

  it("shows the shared password checklist and blocks weak passwords on submit", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();

    // Floating trigger is icon-only (LibreServ-style big plus) with aria-label.
    await user.click(await screen.findByRole("button", { name: /^Add user$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /Add a user/i })).toBeTruthy();
    expect(within(dialog).getByLabelText(/^Name$/i)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Username/i)).toBeTruthy();
    expect(within(dialog).getByLabelText("Role")).toBeTruthy();
    expect(within(dialog).getByLabelText(/Admin vs Member/i)).toBeTruthy();

    const password = within(dialog).getByLabelText(/^Password/i);
    const addBtn = within(dialog).getByRole("button", { name: /^Add user$/i });

    await user.type(within(dialog).getByLabelText(/Username/i), "jamie");
    await user.type(password, "short1");
    expect(within(dialog).getByText("12+ chars")).toBeTruthy();
    expect(within(dialog).getByText("Not strong enough yet")).toBeTruthy();
    expect(within(dialog).queryByText(/Passwords need at least 12 characters/i)).toBeNull();
    expect(addBtn).not.toBeDisabled();

    await user.click(addBtn);
    // Checklist covers policy; no duplicate error line under the field.
    expect(within(dialog).queryByText(/Passwords need at least 12 characters/i)).toBeNull();
    expect(within(dialog).getByText("12+ chars")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users$/),
      expect.objectContaining({ method: "POST" }),
    );

    await user.clear(password);
    await user.type(password, "abcdefghijkl");
    await user.click(addBtn);
    expect(within(dialog).getByText("numbers")).toBeTruthy();
    expect(within(dialog).queryByText(/Passwords need at least one letter and one number/i)).toBeNull();

    await user.clear(password);
    await user.type(password, "hunter22hunter1");
    expect(within(dialog).getByText("✓ Acceptable")).toBeTruthy();
    expect(within(dialog).queryByText(/Passwords need at least/i)).toBeNull();
    await user.click(within(dialog).getByLabelText("Role"));
    await user.click(await screen.findByRole("option", { name: /^Admin$/i }));
    await user.click(addBtn);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users$/),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"password":"hunter22hunter1"'),
      }),
    );
    const createCall = vi.mocked(fetch).mock.calls.find(
      ([url, init]) => String(url).endsWith("/api/v1/users") && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      username: "jamie",
      password: "hunter22hunter1",
      role: "admin",
    });
  });

  it("shows a floating big plus add-user control below the list, not in the header", async () => {
    stubFetch();
    renderPage();

    await screen.findByRole("region", { name: /User list/i });

    const add = await screen.findByRole("button", { name: /^Add user$/i });
    expect(add.textContent?.trim()).toBe("");
    expect(within(add).queryByText(/Add user/i)).toBeNull();
    expect(add.className).toMatch(/fixed/);
    expect(add.className).toMatch(/bottom-28/);
    expect(add.className).toMatch(/right-8/);
    // Portaled to body so page-enter transforms cannot trap position:fixed.
    expect(add.parentElement).toBe(document.body);
  });
});
