import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SharePage from "./SharePage.jsx";
import { getShareInfo } from "../lib/cloudSource.js";
import { unlockBackups } from "../lib/cloudUnlock.js";
import { userRecordPart } from "@libreloom/ui/lib/cloud/cloudKeys.js";

vi.mock("../lib/cloudSource.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getShareInfo: vi.fn(),
  shareSource: vi.fn(() => ({ lunaId: "l1", listRecords: vi.fn(), getPack: vi.fn() })),
}));

vi.mock("../lib/cloudUnlock.js", async (importOriginal) => ({
  ...(await importOriginal()),
  unlockBackups: vi.fn(),
}));

const TOKEN = "c".repeat(43);
const NOW = 1_800_000_000;
const OWNER_ID = "owner-1";

function setHash(value) {
  window.history.replaceState(null, "", `/share${value}`);
}

function userInfo(overrides = {}) {
  return {
    luna_id: "l1",
    luna_name: "Home",
    sent_by: "max@example.com",
    scope: { kind: "user", value: userRecordPart(OWNER_ID) },
    expires_at: NOW + 7 * 86400,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setHash(`#${TOKEN}`);
});

afterEach(() => {
  setHash("");
});

describe("SharePage", () => {
  it("shows the incomplete-link sentence when the token is missing", () => {
    setHash("#short");
    render(<SharePage />);
    expect(screen.getByRole("alert").textContent).toBe(
      "This link is not complete. Ask the person who sent it to copy the whole link again.",
    );
    expect(getShareInfo).not.toHaveBeenCalled();
  });

  it("shows the server message when the link is gone", async () => {
    getShareInfo.mockRejectedValue(
      Object.assign(new Error("This link has expired or was turned off."), { status: 404 }),
    );
    render(<SharePage />);
    expect((await screen.findByRole("alert")).textContent).toBe("This link has expired or was turned off.");
  });

  it("shows the info line and the phishing line", async () => {
    getShareInfo.mockResolvedValue(userInfo());
    render(<SharePage />);
    expect(await screen.findByText(/max@example.com shared backups from Home/)).toBeTruthy();
    expect(screen.getByText("Type the recovery phrase of the person whose backups these are.")).toBeTruthy();
    expect(screen.getByText(/connect\.luna\.libreloom\.org/)).toBeTruthy();
  });

  it("rejects a recovery phrase that belongs to someone else", async () => {
    getShareInfo.mockResolvedValue(userInfo());
    unlockBackups.mockResolvedValue({ userIds: ["someone-else"], backups: [] });
    render(<SharePage />);
    fireEvent.change(await screen.findByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    expect(
      await screen.findByText(
        "This recovery phrase belongs to someone else. Use the phrase of the person these backups were shared for.",
      ),
    ).toBeTruthy();
  });

  it("shows the browser after a successful unlock and Lock goes back", async () => {
    getShareInfo.mockResolvedValue(userInfo());
    unlockBackups.mockResolvedValue({ userIds: [OWNER_ID], backups: [] });
    render(<SharePage />);
    fireEvent.change(await screen.findByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    expect(await screen.findByText("Viewing shared backups.")).toBeTruthy();
    expect(unlockBackups).toHaveBeenCalledWith(expect.anything(), "one two three", { requireLatest: true });
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByLabelText("Recovery phrase")).toBeTruthy();
  });

  it("keeps only the shared backup for a backup link", async () => {
    getShareInfo.mockResolvedValue(
      userInfo({ scope: { kind: "backup", value: "p1" }, sent_by: "Sam" }),
    );
    unlockBackups.mockResolvedValue({
      userIds: [OWNER_ID],
      backups: [{ protectionId: "p1", name: "Photos", startedBy: OWNER_ID, startedByName: "Alex", versions: [{ createdAt: NOW }] }],
    });
    render(<SharePage />);
    expect(await screen.findByText("Type your recovery phrase.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    await waitFor(() => expect(screen.getByText("Viewing shared backups.")).toBeTruthy());
  });
});
