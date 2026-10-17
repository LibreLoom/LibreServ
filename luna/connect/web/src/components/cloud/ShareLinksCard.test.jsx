import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ShareLinksCard } from "./ShareLinksCard.jsx";
import { listShareLinks, revokeShareLink } from "../../lib/shareLinks.js";
import { userRecordPart } from "@libreloom/ui/lib/cloud/cloudKeys.js";

vi.mock("../../lib/shareLinks.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
}));

const USER_ID = "u1";
const NOW = 1_800_000_000;

const backups = [
  { protectionId: "p1", name: "Photos", startedBy: USER_ID, startedByName: "Alex", versions: [{ createdAt: NOW }] },
];

function link(overrides) {
  return { id: "s1", luna_id: "l1", scope_kind: "user", scope_value: userRecordPart(USER_ID), created_at: NOW, expires_at: NOW + 7 * 86400, last_opened_at: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ShareLinksCard", () => {
  it("names a user link from the unlocked backups and shows Not opened yet", async () => {
    listShareLinks.mockResolvedValue([link()]);
    render(<ShareLinksCard lunaId="l1" backups={backups} />);
    expect(await screen.findByText("Alex")).toBeTruthy();
    expect(screen.getByText("Active backup links")).toBeTruthy();
    expect(screen.getByText(/Not opened yet/)).toBeTruthy();
  });

  it("falls back to One person's backups and One backup when names are unknown", async () => {
    listShareLinks.mockResolvedValue([
      link({ id: "a", scope_value: "nope" }),
      link({ id: "b", scope_kind: "backup", scope_value: "missing", last_opened_at: NOW }),
    ]);
    render(<ShareLinksCard lunaId="l1" backups={backups} />);
    expect(await screen.findByText("One person's backups")).toBeTruthy();
    expect(screen.getByText("One backup")).toBeTruthy();
    expect(screen.getByText(/Last opened/)).toBeTruthy();
  });

  it("names a backup link by its backup name", async () => {
    listShareLinks.mockResolvedValue([link({ id: "c", scope_kind: "backup", scope_value: "p1" })]);
    render(<ShareLinksCard lunaId="l1" backups={backups} />);
    expect(await screen.findByText("Photos")).toBeTruthy();
  });

  it("Turn off calls revoke and reloads the list", async () => {
    listShareLinks.mockResolvedValueOnce([link()]).mockResolvedValueOnce([]);
    revokeShareLink.mockResolvedValue({});
    render(<ShareLinksCard lunaId="l1" backups={backups} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(listShareLinks).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull());
  });

  it("hides links that belong to another Luna", async () => {
    listShareLinks.mockResolvedValue([link({ id: "other", luna_id: "l2" })]);
    const { container } = render(<ShareLinksCard lunaId="l1" backups={backups} />);
    await waitFor(() => expect(listShareLinks).toHaveBeenCalled());
    expect(screen.queryByText("Active backup links")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("shows a load error inline", async () => {
    listShareLinks.mockRejectedValue(new Error("Could not load your links."));
    render(<ShareLinksCard lunaId="l1" backups={backups} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load your links.");
  });
});
