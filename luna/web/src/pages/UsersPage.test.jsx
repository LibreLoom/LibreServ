import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from"@libreloom/ui/context/ThemeContext.jsx";
import UsersPage from "./UsersPage";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch({
  role = "admin",
  privateCount = 0,
  ownerless = 0,
  adopted = [],
  orphans = { owners: [], offline_drives: [] },
  cleaned = [],
  cleanupResult = { ok: true, skipped_readonly: [], failed_drives: [], offline_drives: [] },
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
      if (u.endsWith("/private-count")) {
        return jsonResponse({ count: privateCount });
      }
      if (u.endsWith("/api/v1/private/ownerless")) {
        return jsonResponse({ count: ownerless });
      }
      if (u.endsWith("/api/v1/private/orphans")) {
        return jsonResponse(orphans);
      }
      if (u.includes("/api/v1/private/orphans/") && init?.method === "DELETE") {
        cleaned.push(u);
        return jsonResponse(cleanupResult);
      }
      if (u.endsWith("/adopt-private") && init?.method === "POST") {
        adopted.push(u);
        return jsonResponse({ count: ownerless });
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
    <ToastProvider>
    <Toaster />
    <MemoryRouter>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <UsersPage />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>
    </ToastProvider>,
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

  it("says a removed user's private folders stay behind, hidden", async () => {
    stubFetch({ privateCount: 3 });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Remove Alex/i }));
    expect(await screen.findByText(/Their 3 private folders stay on the drives, hidden from everyone/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/users/2/private-count"), expect.anything());
  });

  it("says nothing about private folders when the user has none", async () => {
    stubFetch({ privateCount: 0 });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Remove Alex/i }));
    expect(await screen.findByText(/Remove "Alex" from this Luna/i)).toBeTruthy();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/private-count"), expect.anything()));
    expect(screen.queryByText(/private folder/i)).toBeNull();
  });

  it("offers to give ownerless private folders to someone", async () => {
    const adopted = [];
    stubFetch({ ownerless: 2, adopted });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/2 private folders came from another Luna and have no owner\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Give private folders to" }));
    await user.click(await screen.findByRole("option", { name: "Alex" }));
    await user.click(screen.getByRole("button", { name: "Give" }));
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(adopted[0]).toMatch(/\/api\/v1\/users\/2\/adopt-private$/);
  });

  it("lists private folders left by removed people and deletes them on confirm", async () => {
    const cleaned = [];
    stubFetch({
      cleaned,
      orphans: {
        owners: [{
          user_id: "gone1",
          username: "sam",
          display_name: "Sam",
          deleted_at: 1,
          total: 2,
          drives: [{ drive_id: "d1", drive_label: "Photos", count: 2, readonly: false }],
        }],
        offline_drives: [],
      },
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Private folders left behind")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Delete private folders left by Sam/i }));
    await user.click(await screen.findByRole("button", { name: /^Delete permanently$/i }));
    await vi.waitFor(() => expect(cleaned).toHaveLength(1));
    expect(cleaned[0]).toMatch(/\/api\/v1\/private\/orphans\/gone1$/);
  });

  it("counts retained Trash items and reports incomplete cleanup", async () => {
    stubFetch({
      orphans: { owners: [{ user_id: "gone", display_name: "Sam", total: 1, drives: [{ count: 1, trash_count: 1, drive_label: "Photos", readonly: false }] }], offline_drives: [] },
      cleanupResult: { ok: false, skipped_readonly: [], failed_drives: ["Photos"], offline_drives: [] },
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/1 item in Trash on Photos/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Delete private folders left by Sam/ }));
    await user.click(await screen.findByRole("button", { name: /^Delete permanently$/ }));
    expect(await screen.findByText("Some private content remains.")).toBeInTheDocument();
    expect(screen.queryByText("Private content deleted.")).not.toBeInTheDocument();
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

  it("adds users from a plus row at the end of the list, styled like a user row", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();

    const list = await screen.findByRole("region", { name: /User list/i });
    const add = within(list).getByRole("button", { name: /^Add user$/i });
    expect(add.textContent?.trim()).toBe("");
    expect(add.className).toMatch(/surface-secondary/);
    expect(add.className).toMatch(/rounded-large-element/);
    expect(add.className).not.toMatch(/fixed/);
    // Last row of the table, after every user.
    const rows = within(list).getAllByRole("row");
    expect(rows[rows.length - 1]).toContainElement(add);

    await user.click(add);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows the add row as the last card on mobile", async () => {
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

    const list = await screen.findByRole("region", { name: /User list/i });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[items.length - 1]).getByRole("button", { name: /^Add user$/i })).toBeInTheDocument();
  });

  it("links Edit to a full page for others and to Settings for yourself", async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByRole("link", { name: /Edit Alex/i })).toHaveAttribute("href", "/settings/users/2");
    expect(screen.getByRole("link", { name: /Edit Demo/i })).toHaveAttribute("href", "/settings#security");
  });

  it("links to settings security when editing yourself instead of opening modal", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();

    const selfEditLink = await screen.findByRole("link", { name: /Edit Demo/i });
    expect(selfEditLink).toHaveAttribute("href", "/settings#security");

    const selfNameLink = within(await screen.findByRole("region", { name: /User list/i })).getByRole("link", { name: /^Demo$/i });
    expect(selfNameLink).toHaveAttribute("href", "/settings#security");

    await user.click(selfEditLink);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

