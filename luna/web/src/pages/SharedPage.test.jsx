import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import SharedPage from "./SharedPage";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const WITH_ME = [
  {
    id: "m1", kind: "path", drive_id: "d1", drive_label: "Photos Drive",
    path: "docs", album_id: "", name: "docs", is_file: false, exists: true,
    caps: "view", shared_by: "Max",
  },
  {
    id: "m2", kind: "path", drive_id: "d1", drive_label: "Photos Drive",
    path: "docs/report.pdf", album_id: "", name: "report.pdf", is_file: true,
    exists: true, caps: "full", shared_by: "Max",
  },
  {
    id: "m3", kind: "path", drive_id: "d2", drive_label: "Archive",
    path: "old", album_id: "", name: "old", is_file: false, exists: false,
    caps: "view",
  },
];

const SHARING = [
  {
    kind: "path", drive_id: "d1", drive_label: "Photos Drive", path: "family",
    album_id: "", name: "family", exists: true, is_file: false,
    my_caps: "full",
    members: [{ id: "m9", user_id: "u2", name: "Sam", caps: "view" }],
    links: [{ id: "l1", caps: "view", url: "/s/tok" }],
  },
];

function stubApi({ role = "user", mine = { sharing: SHARING, with_me: WITH_ME } } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    calls.push([init.method || "GET", u]);
    if (u.endsWith("/api/v1/auth/me")) return json({ id: "u9", username: "me", role });
    if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
    if (u.endsWith("/api/v1/access/mine")) return json(mine);
    if (u.match(/\/api\/v1\/access\/members\/[^/]+$/) && init.method === "DELETE") {
      return json({ ok: true });
    }
    if (u.includes("/api/v1/access/subject")) {
      return json({
        subject: { kind: "path", drive_id: "d1", path: "family", album_id: "", is_file: false, exists: true, name: "family" },
        my_caps: "full", members: [], links: [], inherited_members: [], inherited_links: [],
      });
    }
    if (u.endsWith("/api/v1/users/directory")) return json([]);
    return json({});
  }));
  return calls;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <SharedPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SharedPage", () => {
  it("defaults members to Shared with you and opens files at the file", async () => {
    stubApi();
    renderPage();
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    const open = screen.getAllByRole("link", { name: "Open" })
      .find((a) => a.closest("tr")?.textContent?.includes("report.pdf"));
    expect(open).toHaveAttribute("href", "/drives/d1?path=docs%2Freport.pdf");
    expect(screen.getAllByRole("cell", { name: "Max" }).length).toBeGreaterThan(0);
  });

  it("marks gone items Unavailable with no Open", async () => {
    stubApi();
    renderPage();
    const row = (await screen.findByRole("cell", { name: "old" })).closest("tr");
    expect(within(row).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
  });

  it("switches to Manage sharing and filters by search", async () => {
    stubApi();
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: "Manage sharing" }));
    expect(await screen.findByText("family")).toBeInTheDocument();
    expect(screen.getByText("1 person")).toBeInTheDocument();
    expect(screen.getByText("1 link")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find a shared item"), { target: { value: "zz" } });
    expect(await screen.findByText(/Nothing you manage matches/i)).toBeInTheDocument();
  });

  it("asks before leaving, and cancels cleanly", async () => {
    const calls = stubApi();
    renderPage();
    const row = (await screen.findByRole("cell", { name: "docs" })).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: "Leave" }));
    const dialog = await screen.findByRole("dialog", { name: /Leave docs/i });
    expect(within(dialog).getByText(/access through other shared folders stays/i))
      .toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Leave docs/i })).not.toBeInTheDocument());
    expect(calls.every(([m]) => m !== "DELETE")).toBe(true);
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("leaves on confirm and invalidates the listing", async () => {
    const calls = stubApi();
    renderPage();
    const row = (await screen.findByRole("cell", { name: "docs" })).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: "Leave" }));
    const dialog = await screen.findByRole("dialog", { name: /Leave docs/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => {
      expect(calls.some(([m, u]) => m === "DELETE" && u.endsWith("/access/members/m1"))).toBe(true);
    });
  });

  it("admins with nothing shared land on Manage sharing", async () => {
    stubApi({ role: "admin", mine: { sharing: SHARING, with_me: [] } });
    renderPage();
    expect(await screen.findByText("family")).toBeInTheDocument();
  });
});
