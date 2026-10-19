import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { buildBackupRows } from "../../lib/backupRows.js";
import BackupsLine from "./BackupsLine.jsx";

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

function cloudBackup(overrides = {}) {
  return backup({
    id: "c1",
    source_name: "Documents",
    source_path: "Documents",
    target_drive: undefined,
    target_drive_name: undefined,
    last_checked_at: Math.floor(Date.now() / 1000) - 3 * 24 * 3600,
    check_problem: "",
    source_missing: false,
    ...overrides,
  });
}

/** Rows as the dashboard builds them: drive rows first, then cloud rows. */
function rowsOf(drive = [], cloud = []) {
  return buildBackupRows(drive, cloud);
}

/** Renders the line with a fake API for the all backups modal it can open. */
function renderLine(rows, users = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/users")) return jsonResponse(users);
      return jsonResponse({}, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <BackupsLine rows={rows} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BackupsLine", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    auth.user = { id: "u1", role: "admin" };
  });

  it("renders nothing when there are no backups", () => {
    const { container } = renderLine([]);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: "Backups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "See all backups" })).not.toBeInTheDocument();
  });

  it("renders nothing when rows are missing", () => {
    const { container } = renderLine(undefined);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "See all backups" })).not.toBeInTheDocument();
  });

  it("says all backed up when every backup is fine, with no repeated count", () => {
    renderLine(rowsOf([backup(), backup({ id: "b2", source_name: "Music", source_path: "Music" })]));
    expect(screen.getByRole("region", { name: "Backups" })).toBeInTheDocument();
    expect(screen.getByText("All backed up")).toBeInTheDocument();
    expect(screen.queryByText(/backups$/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See all backups" })).toBeInTheDocument();
  });

  it("shows just the headline for a single backup", () => {
    renderLine(rowsOf([backup()]));
    expect(screen.getByText("All backed up")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Backups" }).querySelectorAll("p")).toHaveLength(1);
  });

  it("says how many need a look, without listing them", () => {
    renderLine(
      rowsOf([
        backup({ state: "failing", last_error: "The backup drive is full." }),
        backup({ id: "b2", source_name: "Music", source_path: "Music" }),
      ]),
    );
    expect(screen.getByText("1 backup needs a look")).toBeInTheDocument();
    // Problems are Needs you's job: no reason, no per-backup rows, no reminder here.
    expect(screen.queryByText("The backup drive is full.")).not.toBeInTheDocument();
    expect(screen.queryByText("Photos")).not.toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.queryByText("Check your recovery phrase")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See all backups" })).toBeInTheDocument();
  });

  it("pluralizes when several backups need a look", () => {
    renderLine(
      rowsOf([
        backup({ state: "failing" }),
        backup({ id: "b2", source_name: "Music", source_path: "Music", state: "stale" }),
      ]),
    );
    expect(screen.getByText("2 backups need a look")).toBeInTheDocument();
  });

  it("does not count stopped backups as needing a look", () => {
    renderLine(rowsOf([backup({ status: "stopped", state: "failing", last_error: "old" })]));
    expect(screen.getByText("All backed up")).toBeInTheDocument();
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });

  it("says when the copies were last tested, using the newest cloud check", () => {
    renderLine(
      rowsOf(
        [backup()],
        [
          cloudBackup({ id: "c1", last_checked_at: Math.floor(Date.now() / 1000) - 3 * 24 * 3600 }),
          cloudBackup({
            id: "c2",
            source_name: "Notes",
            source_path: "Notes",
            last_checked_at: Math.floor(Date.now() / 1000) - 3600,
          }),
        ],
      ),
    );
    expect(screen.getByText("Copies last tested 1 h ago")).toBeInTheDocument();
  });

  it("leaves out the last tested time when no cloud backup was checked yet", () => {
    renderLine(rowsOf([backup()], [cloudBackup({ last_checked_at: undefined })]));
    expect(screen.getByText("All backed up")).toBeInTheDocument();
    expect(screen.queryByText(/copies last tested/)).not.toBeInTheDocument();
  });

  it("keeps the modal out of the page until the button is clicked", () => {
    renderLine(rowsOf([backup()]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("All backups")).not.toBeInTheDocument();
  });

  it("pops in like the other dashboard cards", () => {
    const { container } = renderLine(rowsOf([backup()]), [{ id: "u1", username: "max", display_name: "Max" }]);
    expect(container.querySelector(".pop-in")).not.toBeNull();
  });

  it("opens the all backups modal", async () => {
    renderLine(rowsOf([backup({ state: "stale" })]), [{ id: "u1", username: "max", display_name: "Max" }]);
    await userEvent.click(screen.getByRole("button", { name: "See all backups" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("You")).toBeInTheDocument();
  });

  it("closes the modal again", async () => {
    renderLine(rowsOf([backup()]), [{ id: "u1", username: "max", display_name: "Max" }]);
    await userEvent.click(screen.getByRole("button", { name: "See all backups" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "See all backups" })).toBeInTheDocument();
  });
});
