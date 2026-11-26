import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PrivateItemsRow } from "./PrivateItemsRow.jsx";

function makeBackup(overrides = {}) {
  return {
    protectionId: "p1",
    name: "Diary",
    startedBy: "u1",
    startedByName: "Alex",
    keys: {},
    private: { scope: "s1", sealSecret: new Uint8Array(32), dedupKey: new Uint8Array(32), source: {} },
    versions: [
      { snapshotId: "v2", createdAt: 1700000500, treePackId: "t2", keyVersion: 1 },
      { snapshotId: "v1", createdAt: 1700000000, treePackId: "t1", keyVersion: 1 },
    ],
    ...overrides,
  };
}

describe("PrivateItemsRow", () => {
  it("looks the same for every phrase until something opens: no names, counts or owners", () => {
    render(<PrivateItemsRow backups={[]} onOpen={vi.fn()} />);
    const row = screen.getByRole("region", { name: "Private backups" });
    expect(within(row).getByRole("heading", { name: "Private backups" })).toBeTruthy();
    expect(within(row).getByText("Only the owner's recovery phrase opens private backups.")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.textContent).not.toMatch(/\d/);
  });

  it("lists every private backup the phrase opened together, each with an Open button", () => {
    const onOpen = vi.fn();
    const backups = [makeBackup(), makeBackup({ protectionId: "p2", name: "Taxes" })];
    render(<PrivateItemsRow backups={backups} onOpen={onOpen} />);

    const row = screen.getByRole("region", { name: "Private backups" });
    expect(within(row).getByText("Opened with your recovery phrase.")).toBeTruthy();
    expect(within(row).getByText("Diary")).toBeTruthy();
    expect(within(row).getByText("Taxes")).toBeTruthy();
    expect(within(row).getAllByText("2 versions", { exact: false })).toHaveLength(2);

    const buttons = within(row).getAllByRole("button", { name: "Open" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onOpen).toHaveBeenCalledWith("p2");
  });
});
