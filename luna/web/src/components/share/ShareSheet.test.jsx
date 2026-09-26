import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import ShareSheet from "./ShareSheet.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const CHILD = { kind: "path", driveId: "d1", path: "family/kids", albumId: "", name: "kids" };

function subjectBody(path, overrides = {}) {
  return {
    subject: {
      kind: "path",
      drive_id: "d1",
      path,
      album_id: "",
      is_file: false,
      exists: true,
      name: path ? path.split("/").pop() : "Photos Drive",
      item_count: 0,
    },
    // A manager holds full+share; tests that want a narrower caller
    // override my_caps explicitly.
    my_caps: "full+share",
    members: [],
    links: [],
    inherited_members: [],
    inherited_links: [],
    ...overrides,
  };
}

function stubApi(subjectFor) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    calls.push([init.method || "GET", u, init.body ? JSON.parse(init.body) : null]);
    if (u.endsWith("/api/v1/auth/me")) {
      return json({ id: "u1", username: "max", role: "admin" });
    }
    if (u.endsWith("/api/v1/auth/status")) {
      return json({ has_admin: true });
    }
    if (u.endsWith("/api/v1/users/directory")) {
      return json([{ id: "u2", username: "sam", display_name: "Sam" }]);
    }
    if (u.includes("/api/v1/access/subject")) {
      const path = new URL(u, "http://luna.test").searchParams.get("path") || "";
      return json(subjectFor(path));
    }
    if (u.match(/\/api\/v1\/access\/links\/[^/]+$/) && init.method === "DELETE") {
      return json({ ok: true });
    }
    if (u.match(/\/api\/v1\/access\/links\/[^/]+$/) && init.method === "PATCH") {
      return json({ id: "l1", caps: "view", url: "/s/tok1", has_password: false });
    }
    if (u.match(/\/api\/v1\/access\/members\/[^/]+$/)) {
      return json({ ok: true });
    }
    return json({});
  }));
  return calls;
}

function renderSheet(subject = CHILD) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <ShareSheet subject={subject} open onClose={() => {}} />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShareSheet", () => {
  it("shows direct members with effective caps and a parent-shares banner", async () => {
    stubApi((path) => path === "family/kids"
      ? subjectBody(path, {
          members: [{
            id: "m1", user_id: "u2", name: "Sam", caps: "view",
            can_manage: true, can_remove: true, effective_caps: "full",
          }],
          inherited_members: [{
            id: "m2", user_id: "u3", name: "Alex", caps: "full", shared_by: "Max",
            inherited_from: { kind: "path", drive_id: "d1", path: "family", name: "family", can_inspect: true },
          }],
        })
      : subjectBody(path));
    renderSheet();
    expect(await screen.findByText("Sam")).toBeInTheDocument();
    expect(screen.getByText(/Also has Can view \+ edit through a parent folder/i)).toBeInTheDocument();
    // Inherited grants aren't rows on the child sheet — one banner + button.
    expect(screen.getByText(/1 person shared through family/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View parent shares" })).toBeInTheDocument();
    expect(screen.queryByText(/Alex · Can view \+ edit/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Access for Alex")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Access for Sam")).toBeInTheDocument();
  });

  it("opens the parent's full share sheet layered above and keeps the child's", async () => {
    const calls = stubApi((path) => path === "family/kids"
      ? subjectBody(path, {
          members: [{
            id: "m1", user_id: "u2", name: "Sam", caps: "view",
            can_manage: true, can_remove: true,
          }],
          inherited_members: [{
            id: "m2", user_id: "u3", name: "Alex", caps: "full",
            inherited_from: { kind: "path", drive_id: "d1", path: "family", name: "family", can_inspect: true },
          }],
        })
      : subjectBody(path, {
          members: [{ id: "m2", user_id: "u3", name: "Alex", caps: "full", can_manage: true, can_remove: true }],
        }));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "View parent shares" }));
    await waitFor(() => {
      expect(calls.some(([m, u]) => m === "GET" && u.includes("path=family") && !u.includes("kids")))
        .toBe(true);
    });
    // A second dialog — the parent's sheet with real management controls —
    // layered over the still-mounted child sheet.
    const dialogs = await screen.findAllByRole("dialog", { name: /Sharing/i });
    expect(dialogs.length).toBe(2);
    const parentDialog = dialogs[1];
    expect(within(parentDialog).getByLabelText("Access for Alex")).toBeInTheDocument();
    expect(within(parentDialog).getByRole("button", { name: "New link" })).toBeInTheDocument();
    // Child sheet content is still mounted underneath.
    expect(screen.getByLabelText("Access for Sam")).toBeInTheDocument();
    // Closing the layered sheet returns to the child — no back button needed.
    fireEvent.click(within(parentDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.getAllByRole("dialog", { name: /Sharing/i }).length).toBe(1);
    });
    expect(screen.getByLabelText("Access for Sam")).toBeInTheDocument();
  });

  it("edits a link: unchanged fields stay out of the PATCH", async () => {
    const calls = stubApi((path) => subjectBody(path, {
      links: [{
        id: "l1", caps: "view", url: "/s/tok1", has_password: true,
        expires_at: 2000000000, can_manage: true,
      }],
    }));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Link settings" }));
    const dialog = await screen.findByRole("dialog", { name: /Link settings/i });
    expect(within(dialog).getByLabelText("Link expiry").textContent).toContain("Keep current expiry");
    expect(within(dialog).getByLabelText("Link password")).toHaveValue("");
    fireEvent.click(within(dialog).getByLabelText(/Remove password/i));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patch = calls.find(([m, u]) => m === "PATCH" && u.endsWith("/api/v1/access/links/l1"));
      expect(patch).toBeTruthy();
      expect(patch[2]).toEqual({ password: null });
    });
  });

  it("sends caps and a new expiry only when changed", async () => {
    const calls = stubApi((path) => subjectBody(path, {
      links: [{
        id: "l1", caps: "view", url: "/s/tok1", has_password: false,
        expires_at: null, can_manage: true,
      }],
    }));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Link settings" }));
    const dialog = await screen.findByRole("dialog", { name: /Link settings/i });
    fireEvent.click(within(dialog).getByLabelText("What people with this link can do"));
    fireEvent.click(await screen.findByRole("option", { name: /Can view \+ upload/i }));
    fireEvent.click(within(dialog).getByLabelText("Link expiry"));
    fireEvent.click(await screen.findByRole("option", { name: /Never expires/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patch = calls.find(([m, u]) => m === "PATCH" && u.endsWith("/api/v1/access/links/l1"));
      expect(patch[2]).toEqual({ caps: "view+upload", expires_in_days: null });
    });
  });

  it("confirms before removing a link", async () => {
    const calls = stubApi((path) => subjectBody(path, {
      links: [{ id: "l1", caps: "view", url: "/s/tok1", can_manage: true }],
    }));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Remove this link" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove link/i });
    expect(within(confirm).getByText(/Anyone using this link will lose access/i)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove link" }));
    await waitFor(() => {
      expect(calls.some(([m, u]) => m === "DELETE" && u.endsWith("/api/v1/access/links/l1")))
        .toBe(true);
    });
  });

  it("names the parent but shows no button when it can't be inspected", async () => {
    stubApi((path) => subjectBody(path, {
      my_caps: "view",
      inherited_members: [{
        id: "m2", user_id: "u3", name: "Alex", caps: "full",
        inherited_from: { kind: "path", drive_id: "d1", path: "family", name: "family", can_inspect: false },
      }],
    }));
    renderSheet();
    expect(await screen.findByText(/1 person shared through family/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View .* shares/ })).not.toBeInTheDocument();
  });

  it("never shows a cached address on a link the caller can't manage", async () => {
    try {
      sessionStorage.setItem("luna-link-l1", "http://stale.example/s/tok1");
    } catch { /* sessionStorage may be unavailable */ }
    stubApi((path) => subjectBody(path, {
      my_caps: "view",
      links: [{ id: "l1", caps: "full", has_password: false, can_manage: false }],
    }));
    renderSheet();
    expect(await screen.findByText(/Can view \+ edit/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Share link address")).not.toBeInTheDocument();
    expect(screen.queryByText(/stale\.example/)).not.toBeInTheDocument();
    sessionStorage.removeItem("luna-link-l1");
  });

  it("resets draft state when the subject changes under a colliding key", async () => {
    const subjectA = { kind: "path", driveId: "ab", path: "c", albumId: "", name: "c" };
    const subjectB = { kind: "path", driveId: "a", path: "bc", albumId: "", name: "bc" };
    stubApi((path) => subjectBody(path));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (subject) => (
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AuthProvider>
              <ShareSheet subject={subject} open onClose={() => {}} />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>
    );
    const { rerender } = render(tree(subjectA));
    await screen.findByLabelText("Access level");
    fireEvent.click(screen.getByRole("button", { name: "Add a person" }));
    fireEvent.click(await screen.findByRole("option", { name: "Sam" }));
    expect(screen.getByRole("button", { name: /^Add$/ })).toBeEnabled();
    rerender(tree(subjectB));
    await screen.findByLabelText("Access level");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Add$/ })).toBeDisabled();
    });
  });

  it("keeps the link's current level selectable when the caller can't regrant it", async () => {
    const calls = stubApi((path) => subjectBody(path, {
      my_caps: "view",
      links: [{
        id: "l1", caps: "full", url: "/s/tok1", has_password: false,
        expires_at: null, can_manage: true,
      }],
    }));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Link settings" }));
    const dialog = await screen.findByRole("dialog", { name: /Link settings/i });
    fireEvent.click(within(dialog).getByLabelText("What people with this link can do"));
    fireEvent.click(await screen.findByRole("option", { name: /Can view \+ edit/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patch = calls.find(([m, u]) => m === "PATCH" && u.endsWith("/api/v1/access/links/l1"));
      expect(patch).toBeTruthy();
      expect(patch[2]).toEqual({});
    });
  });

  it("hides manage actions on links beyond the caller's rights", async () => {
    stubApi((path) => subjectBody(path, {
      my_caps: "view",
      links: [{ id: "l1", caps: "full", has_password: false, can_manage: false }],
    }));
    renderSheet();
    expect(await screen.findByText(/Can view \+ edit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove this link" })).not.toBeInTheDocument();
  });
});
