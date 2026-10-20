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
  it("says a person has no private items, and shows any actions beside the status", () => {
    const { rerender } = render(<PrivateItemsRow kind="none" backups={[]} onOpen={vi.fn()} />);
    const row = screen.getByRole("region", { name: "Private items" });
    expect(within(row).getByText("None")).toBeTruthy();
    expect(within(row).getByText("This person has no private items backed up.")).toBeTruthy();

    rerender(<PrivateItemsRow kind="other" backups={[]} onOpen={vi.fn()} actions={<button type="button">Share link</button>} />);
    expect(within(screen.getByRole("region", { name: "Private items" })).getByText("Has private items")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share link" })).toBeTruthy();
  });

  it("for another person shows only the title and the line, with no names, counts or sizes", () => {
    render(<PrivateItemsRow kind="other" backups={[makeBackup()]} onOpen={vi.fn()} />);

    const row = screen.getByRole("region", { name: "Private items" });
    expect(within(row).getByRole("heading", { name: "Private items" })).toBeTruthy();
    expect(within(row).getByText("Only this person's recovery phrase opens these.")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.textContent).not.toMatch(/\d/);
    expect(row.textContent).not.toContain("Diary");
    expect(row.textContent).not.toContain("version");
  });

  it("for you lists each private backup with its name and an Open button", () => {
    const onOpen = vi.fn();
    const backups = [makeBackup(), makeBackup({ protectionId: "p2", name: "Taxes" })];
    render(<PrivateItemsRow kind="mine" backups={backups} onOpen={onOpen} />);

    const row = screen.getByRole("region", { name: "Private items" });
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
