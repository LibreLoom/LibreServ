import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BackupsTab } from "./BackupsPage.jsx";
import { accountSource } from "../lib/cloudSource.js";
import { loadTree, unlockBackups } from "../lib/cloudUnlock.js";
import { listShareLinks } from "../lib/shareLinks.js";

vi.mock("../lib/cloudSource.js", () => ({
  listLunas: vi.fn(),
  accountSource: vi.fn(() => ({ getPack: vi.fn() })),
}));

vi.mock("../lib/cloudUnlock.js", async (importOriginal) => ({
  ...(await importOriginal()),
  unlockBackups: vi.fn(),
  loadTree: vi.fn(),
}));

vi.mock("../lib/shareLinks.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listShareLinks: vi.fn(async () => []),
  createShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
}));

const HOME = { luna_id: "l1", name: "Home", linked: true };
const CABIN = { luna_id: "l2", name: "Cabin", linked: true };

function makeBackup(overrides = {}) {
  return {
    protectionId: "p1",
    name: "Photos",
    startedBy: "u1",
    startedByName: "Alex",
    keys: { 1: { key: "k", dedupKey: "d" } },
    versions: [{ snapshotId: "v1", createdAt: 1700000000, treePackId: "t1", keyVersion: 1 }],
    ...overrides,
  };
}

function renderTab(props) {
  return render(
    <BackupsTab
      me={{ has_card: true, estimated_month: 0 }}
      lunas={[HOME]}
      paired
      onRefresh={vi.fn()}
      setError={vi.fn()}
      error=""
      {...props}
    />,
  );
}

describe("BackupsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountSource.mockImplementation(() => ({ getPack: vi.fn() }));
    loadTree.mockResolvedValue([]);
  });

  it("asks for a card when backups are locked", () => {
    renderTab({ me: { has_card: false }, lunas: [] });
    expect(screen.getByTestId("backups-gated")).toBeTruthy();
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByText(/\$8 \/ terabyte \/ month/i)).toBeTruthy();
    expect(screen.getByText(/Free up to 3× stored amount/i)).toBeTruthy();
    expect(screen.queryByText(/average storage/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
    expect(screen.getByTestId("backup-empty-state")).toBeTruthy();
  });

  it("shows the monthly cost and the unlock card when unlocked", () => {
    renderTab({ me: { has_card: true, estimated_month: 3.5 } });
    expect(screen.getByTestId("backups-open")).toBeTruthy();
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByTestId("backup-monthly-cost")).toBeTruthy();
    expect(screen.getByText("$3.50")).toBeTruthy();
    expect(screen.getByText(/This month/i)).toBeTruthy();
    expect(screen.getByText(/\$0\.01 \/ GB/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Turn off payment/i })).toBeTruthy();
    expect(screen.getByLabelText("Recovery phrase")).toBeTruthy();
  });

  it("uses destructive variant for turn off payment", () => {
    renderTab({ me: { has_card: true, estimated_month: 1 } });
    const turnOff = screen.getByRole("button", { name: /Turn off payment/i });
    expect(turnOff.className).toMatch(/destructive/);
  });

  it("opens a confirmation panel before turning payment off", () => {
    renderTab({ me: { has_card: true, estimated_month: 0 } });
    fireEvent.click(screen.getByRole("button", { name: /Turn off payment/i }));
    expect(screen.getByTestId("backup-cancel-confirm")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Keep payment on/i })).toBeTruthy();
  });

  it("shows remaining days and add-card when a purge clock is running", () => {
    const later = Math.floor(Date.now() / 1000) + 10 * 86400;
    renderTab({
      me: { has_card: false, backup_purge_after: later },
      lunas: [{ ...HOME, linked: false }],
      paired: false,
    });
    expect(screen.getByTestId("backups-purging")).toBeTruthy();
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByText(/10 more days/i)).toBeTruthy();
    expect(screen.getByText(/Download anything you need/i)).toBeTruthy();
    expect(screen.getByText(/no longer linked/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
  });

  it("shows the empty state when no Luna is linked", () => {
    renderTab({ lunas: [] });
    expect(screen.getByTestId("backup-empty-state")).toBeTruthy();
    expect(screen.queryByLabelText("Recovery phrase")).toBeNull();
  });

  it("shows the unlock card for a single Luna and no pills", () => {
    renderTab({ lunas: [HOME] });
    expect(screen.getByLabelText("Recovery phrase")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Choose a Luna" })).toBeNull();
  });

  it("shows the browser after a successful unlock, and Lock goes back", async () => {
    unlockBackups.mockResolvedValue({ userIds: [], backups: [makeBackup()] });
    renderTab({ lunas: [HOME] });
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    expect(await screen.findByRole("button", { name: "Lock" })).toBeTruthy();
    expect(unlockBackups).toHaveBeenCalledWith(expect.anything(), "one two three");
    expect(accountSource).toHaveBeenCalledWith("l1");
    expect(screen.queryByLabelText("Recovery phrase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(screen.getByLabelText("Recovery phrase")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });

  it("offers a Share link button per group and per backup once unlocked", async () => {
    unlockBackups.mockResolvedValue({ userIds: [], backups: [makeBackup()] });
    renderTab({ lunas: [HOME] });
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    expect(await screen.findByRole("button", { name: "Lock" })).toBeTruthy();
    // One group (Alex) plus one backup (Photos).
    expect(screen.getAllByRole("button", { name: "Share link" })).toHaveLength(2);
    expect(listShareLinks).toHaveBeenCalled();
  });

  it("shows one pill per Luna and locks when switching Luna", async () => {
    unlockBackups.mockResolvedValue({ userIds: [], backups: [makeBackup()] });
    renderTab({ lunas: [HOME, CABIN] });
    const group = screen.getByRole("group", { name: "Choose a Luna" });
    expect(group.querySelectorAll("button").length).toBe(2);
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    expect(await screen.findByRole("button", { name: "Lock" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cabin" }));
    expect(screen.getByRole("button", { name: "Cabin" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
    expect(screen.getByLabelText("Recovery phrase")).toBeTruthy();
  });

  it("shows the unpaired note for a Luna that is no longer linked", () => {
    renderTab({ lunas: [{ ...HOME, linked: false }], paired: false });
    expect(screen.getByText(/no longer linked to this account/i)).toBeTruthy();
  });

  it("does not show the unpaired note for a linked Luna", () => {
    renderTab({ lunas: [HOME] });
    expect(screen.queryByText(/no longer linked to this account/i)).toBeNull();
  });
});
