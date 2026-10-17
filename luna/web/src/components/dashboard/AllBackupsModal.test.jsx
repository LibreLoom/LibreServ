import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AllBackupsModal, { backupStatus, sortByUrgency } from "./AllBackupsModal.jsx";

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

function renderModal(backups = BACKUPS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/api/v1/users")) return jsonResponse(USERS);
      return jsonResponse({}, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AllBackupsModal open onClose={() => {}} backups={backups} />
    </QueryClientProvider>,
  );
}

describe("AllBackupsModal", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups backups by creator with names", async () => {
    renderModal();
    expect(await screen.findByRole("heading", { name: "Max" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ana" })).toBeInTheDocument();
    const maxGroup = screen.getByRole("heading", { name: "Max" }).closest("section");
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

  it("explains where copies of stopped backups are", async () => {
    renderModal();
    expect(await screen.findByText(/Copies are in the Backups folder on/)).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("opens the protect sheet for an active row", async () => {
    renderModal();
    // Wait for user names to load so the group (and its rows) are not remounted mid-click.
    await screen.findByRole("heading", { name: "ana" });
    await userEvent.click(screen.getByRole("button", { name: "Open protection for Music" }));
    await waitFor(() => expect(screen.getByTestId("protect-sheet")).toHaveTextContent("d1:Music"));
  });

  it("sorts hard errors first, then oldest good copy", () => {
    const sorted = sortByUrgency([
      backup({ id: "x", last_ok_at: 100 }),
      backup({ id: "y", last_ok_at: 500 }),
      backup({ id: "z", last_ok_at: 900, hard: true }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["z", "x", "y"]);
  });

  it("maps status to pills", () => {
    expect(backupStatus(backup()).label).toBe("Backed up");
    expect(backupStatus(backup({ state: "stale" })).label).toBe("Needs a look");
    expect(backupStatus(backup({ status: "source_gone" })).label).toBe("Source deleted");
  });
});
