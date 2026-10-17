import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BackupsCard from "./BackupsCard.jsx";

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

function renderCard(backups, users = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/backups")) return jsonResponse(backups);
      if (u.endsWith("/api/v1/users")) return jsonResponse(users);
      return jsonResponse({}, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BackupsCard />
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
});
