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

function stubApi(subjectFor, directory = [{ id: "u2", username: "sam", display_name: "Sam" }]) {
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
      return json(directory);
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
  it("leaves Admins out of the people to share with", async () => {
    stubApi((path) => subjectBody(path), [
      { id: "u3", username: "root", display_name: "Root Admin", admin: true, shareable: true },
    ]);
    renderSheet();
    expect(await screen.findByText("Admins can already open everything except other people's private items.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a person" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Private: only people you add here/)).not.toBeInTheDocument();
  });

  it("opens straight to the New link form and keeps it open", async () => {
    stubApi((path) => {
      const base = subjectBody(path);
      return { ...base, subject: { ...base.subject, path: "Dish.lunaform", name: "Dish.lunaform", is_file: true } };
    });
    const file = { kind: "path", driveId: "d1", path: "Dish.lunaform", albumId: "", name: "Dish.lunaform" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AuthProvider>
              <ShareSheet subject={file} open startWithNewLink onClose={() => {}} />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );
    expect(await screen.findByRole("dialog", { name: "New link" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByRole("dialog", { name: "New link" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Sharing" })).toBeNull();
  });

  it("keeps the New link form when it opens while the subject is still loading", async () => {
    stubApi((path) => {
      const base = subjectBody(path);
      return { ...base, subject: { ...base.subject, path: "Dish.lunaform", name: "Dish.lunaform", is_file: true } };
    });
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).includes("/api/v1/access/subject")) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return inner(url, init);
    });
    const onClose = vi.fn();
    const file = { kind: "path", driveId: "d1", path: "Dish.lunaform", albumId: "", name: "Dish.lunaform" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AuthProvider>
              <ShareSheet subject={file} open startWithNewLink onClose={onClose} />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );
    // Before the subject loads, the plain Sharing sheet must not show.
    expect(screen.queryByRole("dialog", { name: "Sharing" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "New link" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByRole("dialog", { name: "New link" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    unmount();
  });

  describe("private items", () => {
    const privateBody = (path, extra = {}) => {
      const base = subjectBody(path);
      return { ...base, subject: { ...base.subject, private: true, private_folder: true }, ...extra };
    };

    it("explains that only added people can open it", async () => {
      stubApi((path) => privateBody(path));
      renderSheet();
      expect(
        await screen.findByText("Private folder: only people added here can open it. Sharing a folder above it doesn't include it."),
      ).toBeInTheDocument();
    });

    it("offers Admins as people to share with", async () => {
      stubApi((path) => privateBody(path), [
        { id: "u3", username: "root", display_name: "Root Admin", admin: true, shareable: true },
      ]);
      renderSheet();
      await screen.findByText(/Private folder: only people added here/);
      expect(await screen.findByRole("button", { name: "Add a person" })).toBeInTheDocument();
      expect(screen.queryByText(/Admins can already open everything/)).not.toBeInTheDocument();
    });

    it("shows the shares Luna says still reach in", async () => {
      // Luna leaves out shares from above the private item, so whatever it
      // sends is a share at or below the boundary and is shown.
      stubApi((path) => privateBody(path, {
        inherited_members: [{
          id: "m2", user_id: "u3", name: "Alex", caps: "view",
          inherited_from: { kind: "path", drive_id: "d1", path: "family/private", name: "private", can_inspect: true },
        }],
      }));
      renderSheet();
      await screen.findByText(/Private folder: only people added here/);
      expect(screen.getByText(/1 person shared through private/)).toBeInTheDocument();
    });
  });

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
    expect(screen.getByText(/With access from a folder or drive above this, they have: Can view \+ edit/i)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Settings for link 1" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Settings for link 1" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Remove link 1" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove link/i });
    expect(within(confirm).getByText(/Anyone using this link will lose access/i)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove link" }));
    await waitFor(() => {
      expect(calls.some(([m, u]) => m === "DELETE" && u.endsWith("/api/v1/access/links/l1")))
        .toBe(true);
    });
  });

  it("names who made each link, including a maker who is gone", async () => {
    stubApi((path) => subjectBody(path, {
      links: [
        { id: "l1", caps: "view", url: "/s/tok1", can_manage: true, created_by: "u2" },
        { id: "l2", caps: "view", url: "/s/tok2", can_manage: true, created_by: "u9" },
      ],
    }));
    renderSheet();
    await screen.findByText("Made by a deleted account");
    const makers = [...document.querySelectorAll("[data-slot=link-maker]")];
    expect(makers.map((el) => el.textContent)).toEqual(["Made by Sam", "Made by a deleted account"]);
    // The name is a chip, not a bare font change.
    expect(within(/** @type {HTMLElement} */ (makers[0])).getByText("Sam")).toHaveAttribute("data-slot", "inline-pill");
  });

  describe("a Read member", () => {
    const readBody = (path) => subjectBody(path, {
      my_caps: "view",
      member_count: 2,
      links: [
        { id: "l1", caps: "view", url: null, has_password: false, can_manage: false, created_by: "u1" },
        { id: "l2", caps: "full", url: null, has_password: true, can_manage: false, created_by: "u2" },
      ],
    });

    it("sees every link and who made it, but no way to change one", async () => {
      stubApi(readBody, [
        { id: "u1", username: "max", display_name: "Max" },
        { id: "u2", username: "sam", display_name: "Sam" },
      ]);
      renderSheet();
      await waitFor(() => {
        const makers = [...document.querySelectorAll("[data-slot=link-maker]")].map((el) => el.textContent);
        expect(makers).toEqual(["Made by Max", "Made by Sam"]);
      });
      expect(screen.queryByRole("button", { name: /Settings for link/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove link/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New link" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Share link address")).not.toBeInTheDocument();
      // One line says why, with Read explained one step in.
      const note = /** @type {HTMLElement} */ (document.querySelector("[data-slot=links-read-note]"));
      expect(note).toHaveTextContent("You have Read access, so you can see these links but not change them.");
    });

    it("says there are no links yet instead of an empty section", async () => {
      stubApi((path) => subjectBody(path, { my_caps: "view", member_count: 0 }));
      renderSheet();
      expect(await screen.findByText("No links yet.")).toBeInTheDocument();
      expect(screen.getByText("Nobody has been added here yet.")).toBeInTheDocument();
      expect(document.querySelector("[data-slot=links-read-note]")).toBeNull();
    });

    it("gets the head count, not the roster or an Add button", async () => {
      stubApi(readBody);
      renderSheet();
      expect(await screen.findByText("2 people added here.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add a person" })).not.toBeInTheDocument();
      expect(screen.queryByText("Everyone already has access.")).not.toBeInTheDocument();
    });
  });

  it("lets a Write member make links and manage the ones within their access", async () => {
    stubApi((path) => subjectBody(path, {
      my_caps: "view+upload",
      member_count: 1,
      links: [
        { id: "l1", caps: "view", url: "/s/tok1", has_password: false, can_manage: true, created_by: "u2" },
        { id: "l2", caps: "full", url: null, has_password: false, can_manage: false, created_by: "u2" },
      ],
    }));
    renderSheet();
    expect(await screen.findByRole("button", { name: "New link" })).toBeInTheDocument();
    // Only the link inside their access gets controls and an address.
    expect(screen.getAllByRole("button", { name: /Settings for link/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Remove link/ })).toHaveLength(1);
    expect(screen.getAllByLabelText("Share link address")).toHaveLength(1);
    expect(document.querySelector("[data-slot=links-read-note]")).toBeNull();
    // Still no roster: that needs the share bit.
    expect(screen.queryByRole("button", { name: "Add a person" })).not.toBeInTheDocument();
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

  it("keeps an inspectable parent when a non-inspectable twin names the same folder", async () => {
    stubApi((path) => subjectBody(path, {
      my_caps: "view",
      inherited_members: [{
        id: "m2", user_id: "u3", name: "Alex", caps: "view",
        inherited_from: { kind: "path", drive_id: "d1", path: "family/photos", can_inspect: true },
      }],
      inherited_links: [{
        id: "l9", caps: "view",
        inherited_from: { kind: "path", drive_id: "d1", path: "family/photos", can_inspect: false },
      }],
    }));
    renderSheet();
    // No name on the row: the folder's own name stands in for it, and the
    // inspectable twin keeps the button.
    expect(await screen.findByText(/1 person and 1 link shared through photos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View parent shares" })).toBeInTheDocument();
  });

  it("says how soon a link expires within a day, and names each row's buttons", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
    stubApi((path) => subjectBody(path, {
      links: [
        { id: "l1", caps: "view", url: "/s/tok1", can_manage: true, expires_at: soon },
        { id: "l2", caps: "view+upload", url: "/s/tok2", can_manage: true },
      ],
    }));
    renderSheet();
    expect(await screen.findByText(/expires in 3 hours/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings for link 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings for link 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove link 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove link 2" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Add a person" }));
    fireEvent.click(await screen.findByRole("button", { name: "Person" }));
    fireEvent.click(await screen.findByRole("option", { name: "Sam" }));
    expect(screen.getByRole("button", { name: /^Add$/ })).toBeEnabled();
    rerender(tree(subjectB));
    fireEvent.click(await screen.findByRole("button", { name: "Add a person" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Settings for link 1" }));
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
    expect(screen.queryByRole("button", { name: /Settings for link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove link/ })).not.toBeInTheDocument();
  });
});
