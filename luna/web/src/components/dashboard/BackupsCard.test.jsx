import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import BackupsCard from "./BackupsCard.jsx";

const auth = vi.hoisted(() => ({ user: { id: "u1", role: "admin" } }));

vi.mock("../../context/AuthContext.jsx", () => ({
  useAuth: () => auth,
}));

vi.mock("../files/ProtectSheet.jsx", () => ({
  default: ({ driveId, path }) => <div data-testid="protect-sheet">{`${driveId}:${path}`}</div>,
}));

vi.mock("../cloud/RecoveryPhraseCheck.jsx", () => ({
  default: ({ lunaId, onClose }) => (
    <div data-testid="phrase-check">
      <span>{lunaId}</span>
      <button onClick={onClose}>Close check</button>
    </div>
  ),
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

function cloudBackup(overrides = {}) {
  return backup({
    id: "c1",
    kind: "cloud",
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

/**
 * opts.cloud: rows for /api/v1/cloud/backups (default [])
 * opts.cloudFail: make the cloud request fail
 * opts.phrase: body for /api/v1/cloud/phrase (default: not due)
 */
function renderCard(backups, users = [], opts = {}) {
  const phrase = opts.phrase ?? { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/backups")) return jsonResponse(backups);
      if (u.endsWith("/api/v1/cloud/backups")) {
        return opts.cloudFail ? jsonResponse({ error: "down" }, 500) : jsonResponse(opts.cloud ?? []);
      }
      if (u.endsWith("/api/v1/cloud/phrase")) return jsonResponse(phrase);
      if (u.endsWith("/api/v1/users")) return jsonResponse(users);
      return jsonResponse({}, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <BackupsCard />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BackupsCard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the empty state when there are no backups", async () => {
    renderCard([]);
    expect(await screen.findByText("No backups yet.")).toBeInTheDocument();
    expect(screen.getByText("Click the shield icon beside an item to back it up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "See all backups" })).not.toBeInTheDocument();
  });

  it("says all backed up when every backup is fine", async () => {
    renderCard([backup(), backup({ id: "b2", source_name: "Music", source_path: "Music" })]);
    expect(await screen.findByText("All backed up")).toBeInTheDocument();
    expect(screen.getByText("2 backups")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See all backups" })).toBeInTheDocument();
  });

  it("lists a failing backup with its reason and opens its protect sheet", async () => {
    renderCard([
      backup({ state: "failing", last_error: "The backup drive is full." }),
      backup({ id: "b2", source_name: "Music", source_path: "Music" }),
    ]);
    expect(await screen.findByText("1 backup needs a look")).toBeInTheDocument();
    expect(screen.getByText("The backup drive is full.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Photos" }));
    expect(screen.getByTestId("protect-sheet")).toHaveTextContent("d1:Photos");
  });

  it("does not count stopped backups as needing a look", async () => {
    renderCard([backup({ status: "stopped", state: "failing", last_error: "old" })]);
    expect(await screen.findByText("All backed up")).toBeInTheDocument();
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });

  it("opens the all backups modal", async () => {
    renderCard([backup({ state: "stale" })], [{ id: "u1", username: "max", display_name: "Max" }]);
    await userEvent.click(await screen.findByRole("button", { name: "See all backups" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Max")).toBeInTheDocument();
  });

  it("shows a failing cloud backup with a Cloud pill and its reason", async () => {
    renderCard([backup()], [], {
      cloud: [cloudBackup({ state: "failing", last_error: "Cloud upload failed." })],
    });
    expect(await screen.findByText("1 backup needs a look")).toBeInTheDocument();
    const item = screen.getByRole("button", { name: "Open Documents" }).closest("li");
    expect(within(item).getByText("Cloud")).toBeInTheDocument();
    expect(within(item).getByText("Cloud upload failed.")).toBeInTheDocument();
  });

  it("says when the copies were last tested, using the newest cloud check", async () => {
    renderCard([backup()], [], {
      cloud: [
        cloudBackup({ id: "c1", last_checked_at: Math.floor(Date.now() / 1000) - 3 * 24 * 3600 }),
        cloudBackup({ id: "c2", source_name: "Notes", source_path: "Notes", last_checked_at: Math.floor(Date.now() / 1000) - 3600 }),
      ],
    });
    expect(await screen.findByText(/3 backups · copies last tested 1 h ago/)).toBeInTheDocument();
  });

  it("shows drive rows when the cloud request fails", async () => {
    renderCard([backup({ state: "failing", last_error: "The backup drive is full." })], [], { cloudFail: true });
    expect(await screen.findByText("The backup drive is full.")).toBeInTheDocument();
    expect(screen.getByText("1 backup needs a look")).toBeInTheDocument();
  });

  it("shows the recovery phrase reminder when a check is due and a cloud backup exists", async () => {
    renderCard([], [], {
      cloud: [cloudBackup()],
      phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: true },
    });
    expect(await screen.findByText("Check your recovery phrase")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(screen.getByTestId("phrase-check")).toHaveTextContent("luna-1");
    await userEvent.click(screen.getByRole("button", { name: "Close check" }));
    expect(screen.queryByTestId("phrase-check")).not.toBeInTheDocument();
  });

  it("does not show the recovery phrase reminder without a cloud backup", async () => {
    renderCard([backup()], [], {
      phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: true },
    });
    expect(await screen.findByText("All backed up")).toBeInTheDocument();
    expect(screen.queryByText("Check your recovery phrase")).not.toBeInTheDocument();
  });

  it("shows at most three items, failing rows first and the reminder last", async () => {
    renderCard(
      [
        backup({ id: "b1", source_name: "Photos", state: "failing", last_error: "Full." }),
        backup({ id: "b2", source_name: "Music", source_path: "Music", state: "failing", last_error: "Full." }),
      ],
      [],
      {
        cloud: [cloudBackup()],
        phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: true },
      },
    );
    await screen.findByText("2 backups need a look");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Photos");
    expect(items[1]).toHaveTextContent("Music");
    expect(items[2]).toHaveTextContent("Check your recovery phrase");
  });

  it("leaves out the reminder when three backups already need a look", async () => {
    renderCard(
      [
        backup({ id: "b1", source_name: "Photos", state: "failing", last_error: "Full." }),
        backup({ id: "b2", source_name: "Music", source_path: "Music", state: "failing", last_error: "Full." }),
        backup({ id: "b3", source_name: "Docs", source_path: "Docs", state: "failing", last_error: "Full." }),
      ],
      [],
      {
        cloud: [cloudBackup()],
        phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: true },
      },
    );
    await screen.findByText("3 backups need a look");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("Check your recovery phrase")).not.toBeInTheDocument();
  });
});
