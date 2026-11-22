import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AllBackupsModal from "./AllBackupsModal.jsx";
import { ToastProvider, useToastList } from "@libreloom/ui/context/ToastContext.jsx";
import { backupStatus, sortByUrgency } from "../../lib/backupRows.js";

function ToastText() {
  const toasts = useToastList();
  return (
    <div>
      {toasts.map((t) => (
        <p key={t.id}>{t.message}</p>
      ))}
    </div>
  );
}

const auth = vi.hoisted(() => ({ user: { id: "u1", role: "admin" } }));

vi.mock("../../context/AuthContext.jsx", () => ({
  useAuth: () => auth,
}));

vi.mock("../files/ProtectSheet.jsx", () => ({
  default: ({ driveId, path }) => <div data-testid="protect-sheet">{`${driveId}:${path}`}</div>,
}));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function backup(overrides = {}) {
  return {
    id: "b1",
    kind: "drive",
    source_drive: "d1",
    source_drive_name: "Photos drive",
    source_path: "Photos",
    source_name: "Photos",
    target_drive: "d2",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_ok_at: Math.floor(Date.now() / 1000) - 3600,
    last_error: "",
    hard: false,
    first_done: true,
    created_by: "u1",
    can_delete: true,
    ...overrides,
  };
}

const USERS = [
  { id: "u1", username: "max", display_name: "Max" },
  { id: "u2", username: "ana", display_name: "" },
];

const BACKUPS = [
  backup({ id: "a", source_name: "Photos", created_by: "u1", state: "failing" }),
  backup({ id: "b", source_name: "Music", source_path: "Music", created_by: "u2" }),
  backup({ id: "c", source_name: "Old docs", source_path: "Old", created_by: "u1", status: "stopped" }),
];

const EMPTY_SUMMARY = { owners: [] };

/**
 * Renders the modal with a fake API. `summary` answers the private items query,
 * `removed` is the count the DELETE answers with.
 */
function renderModal(backups = BACKUPS, { summary = EMPTY_SUMMARY, removed = 2 } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const path = String(url);
    if (init?.method === "DELETE") return jsonResponse({ removed });
    if (path.endsWith("/api/v1/users")) return jsonResponse(USERS);
    if (path.endsWith("/api/v1/private-backups/summary")) return jsonResponse(summary);
    if (path.endsWith("/resume") && init?.method === "POST") return jsonResponse(backup({ status: "active" }));
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AllBackupsModal open onClose={() => {}} backups={backups} />
          <ToastText />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { fetchMock };
}

describe("AllBackupsModal", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    auth.user = { id: "u1", role: "admin" };
  });

  it("groups backups by creator with names", async () => {
    renderModal();
    expect(await screen.findByRole("heading", { name: "You" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "ana" })).toBeInTheDocument();
    const maxGroup = screen.getByRole("heading", { name: "You" }).closest("section");
    expect(within(maxGroup).getByText("Photos")).toBeInTheDocument();
    expect(within(maxGroup).getByText("Old docs")).toBeInTheDocument();
  });

  it("filters to backups that need a look", async () => {
    renderModal();
    await userEvent.click(await screen.findByRole("radio", { name: "Needs a look" }));
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.queryByText("Music")).not.toBeInTheDocument();
    expect(screen.queryByText("Old docs")).not.toBeInTheDocument();
  });

  it("Cloud chip shows only cloud rows", async () => {
    renderModal([
      ...BACKUPS,
      backup({ id: "k", kind: "cloud", source_name: "Cloud photos", destination: "Cloud", created_by: "u1" }),
    ]);
    await userEvent.click(await screen.findByRole("radio", { name: "Cloud" }));
    expect(screen.getByText("Cloud photos")).toBeInTheDocument();
    expect(screen.queryByText("Photos")).not.toBeInTheDocument();
    expect(screen.queryByText("Music")).not.toBeInTheDocument();
  });

  it("explains where copies of stopped backups are", async () => {
    renderModal();
    expect(await screen.findByRole("link", { name: /Open the Backups folder on/ })).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("opens the protect sheet for an active row", async () => {
    renderModal();
    // Wait for user names to load so the group (and its rows) are not remounted mid-click.
    await screen.findByRole("heading", { name: "ana" });
    await userEvent.click(screen.getByRole("button", { name: "Details for Music" }));
    await waitFor(() => expect(screen.getByTestId("protect-sheet")).toHaveTextContent("d1:Music"));
  });

  it("runs an active backup from its row", async () => {
    const { fetchMock } = renderModal();
    await screen.findByRole("heading", { name: "ana" });
    await userEvent.click(screen.getAllByRole("button", { name: "Back up now" })[0]);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/run") && init?.method === "POST")).toBe(true),
    );
  });

  it("a private items row per owner with a combined status and no names of items", async () => {
    renderModal(BACKUPS, {
      summary: {
        owners: [
          { owner_id: "u1", name: "Max", deleted: false, backups: 2, needs_look: true },
          { owner_id: "u2", name: "ana", deleted: false, backups: 1, needs_look: false },
        ],
      },
    });
    const maxGroup = (await screen.findByRole("heading", { name: "You" })).closest("section");
    expect(await within(maxGroup).findByText("Private items")).toBeInTheDocument();
    expect(within(maxGroup).getByText("Needs a look")).toBeInTheDocument();
    expect(within(maxGroup).getByText("Yours. To see each backup, open the private folder and select Back up.")).toBeInTheDocument();

    const anaGroup = screen.getByRole("heading", { name: "ana" }).closest("section");
    expect(within(anaGroup).getByText("All backed up")).toBeInTheDocument();
    expect(within(anaGroup).getByText("Only ana can open these items.")).toBeInTheDocument();
    // Private items are never listed by name, so no private item row text appears.
    expect(within(anaGroup).queryByText("Private")).not.toBeInTheDocument();
  });

  it("deleted owner row offers Remove to an Admin; confirming calls DELETE and toasts", async () => {
    const { fetchMock } = renderModal(BACKUPS, {
      summary: {
        owners: [{ owner_id: "u3", name: "", deleted: true, backups: 2, needs_look: false }],
      },
      removed: 2,
    });
    const group = (await screen.findByRole("heading", { name: "Deleted user" })).closest("section");
    expect(within(group).getByText("Private items · deleted user")).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Remove" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove backups" }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(del?.[0]).toContain("/api/v1/private-backups/owners/u3");
    });
    expect(await screen.findByText("Removed 2 backups")).toBeInTheDocument();
  });

  it("storage-full advice names who can act: Admin sees add storage, a Member sees the neutral line", async () => {
    const moving = { percent: 50, paused_full: true };
    const rows = [backup({ id: "m", source_name: "Moving photos", created_by: "u1", moving })];
    renderModal(rows);
    expect(await screen.findByText(/add storage on Luna Connect/)).toBeInTheDocument();
  });

  it("a Member gets the neutral storage-full line", async () => {
    auth.user = { id: "u2", role: "member" };
    const moving = { percent: 50, paused_full: true };
    renderModal([backup({ id: "m", source_name: "Moving photos", created_by: "u1", moving })]);
    expect(await screen.findByText(/An Admin can free up space or add storage/)).toBeInTheDocument();
    expect(screen.queryByText(/add storage on Luna Connect/)).not.toBeInTheDocument();
  });

  it("a Member sees no Remove", async () => {
    auth.user = { id: "u2", role: "member" };
    renderModal(BACKUPS, {
      summary: {
        owners: [{ owner_id: "u3", name: "", deleted: true, backups: 2, needs_look: false }],
      },
    });
    const group = (await screen.findByRole("heading", { name: "Deleted user" })).closest("section");
    expect(within(group).getByText("Private items · deleted user")).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("a source-gone drive row links to the Backups folder; a cloud one links to Luna Connect", async () => {
    renderModal([
      backup({ id: "s", source_name: "Old photos", status: "source_gone", created_by: "u1" }),
      backup({
        id: "k",
        kind: "cloud",
        source_name: "Cloud docs",
        status: "source_gone",
        destination: "Cloud",
        created_by: "u1",
      }),
    ]);
    const driveLink = await screen.findByRole("link", { name: /Open the Backups folder on/ });
    expect(driveLink).toHaveAttribute("href", "/files/d2?path=.luna-backups");

    const connectLink = screen.getByRole("link", { name: "Open Luna Connect" });
    expect(connectLink).toHaveAttribute("href", "https://connect.luna.libreloom.org/backups");
    expect(connectLink).toHaveAttribute("target", "_blank");
    expect(connectLink).toHaveAttribute("rel", "noreferrer");
  });

  it("sorts hard errors first, then oldest good copy", () => {
    const sorted = sortByUrgency([
      backup({ id: "x", last_ok_at: 100 }),
      backup({ id: "y", last_ok_at: 500 }),
      backup({ id: "z", last_ok_at: 900, hard: true }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["z", "x", "y"]);
  });

  it("a backup that came back from a drive is paused, needs a look, and its owner can resume it", async () => {
    const { fetchMock } = renderModal([
      backup({ id: "p", source_name: "Taxes", status: "paused", stop_reason: "This backup came back from a drive.", can_resume: true }),
    ]);
    await screen.findByRole("heading", { name: "You" });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Why this backup is paused" })).toBeInTheDocument();
    // It doesn't offer to run before it's resumed.
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Needs a look" }));
    expect(screen.getByText("Taxes")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resume Taxes" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/v1/backups/p/resume") && init?.method === "POST"),
      ).toBe(true),
    );
    expect(await screen.findByText("Backup resumed. It runs again on its schedule.")).toBeInTheDocument();
  });

  it("someone who may not resume a paused backup sees no Resume", async () => {
    auth.user = { id: "u2", role: "user" };
    renderModal([backup({ id: "p", source_name: "Taxes", status: "paused", can_resume: false, can_delete: false })]);
    await screen.findByText("Taxes");
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).not.toBeInTheDocument();
  });

  it("maps status to pills", () => {
    expect(backupStatus(backup({ status: "paused" }))).toMatchObject({ label: "Paused", variant: "warning" });
    expect(backupStatus(backup({ status: "paused" })).hint).toMatch(/found this backup on a drive/);
    expect(backupStatus(backup()).label).toBe("Backup successful");
    expect(backupStatus(backup({ state: "stale" })).label).toBe("Last backed up 1 h ago.");
    expect(backupStatus(backup({ status: "source_gone" })).label).toBe("Original is gone");
  });
});
