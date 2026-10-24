import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import FileOpItemLine from "./FileOpItemLine.jsx";
import { fileClash, folderClash, renderWithOps } from "./fileOpsTestUtils.jsx";

function line(ops, itemIndex = 0) {
  const result = renderWithOps(null, ops);
  const op = result.store.getState().ops[0];
  result.unmount();
  const again = renderWithOps(<div className="surface-primary p-3"><FileOpItemLine op={op} item={op.items[itemIndex]} /></div>, ops);
  return again;
}

const base = { id: "op1", kind: "upload", state: "running", destLabel: "Inbox" };

describe("FileOpItemLine", () => {
  it("shows a running upload with its percent and a cancel button", () => {
    line([{ ...base, items: [{ id: "i1", name: "a.txt", state: "uploading", size: 100, received: 40 }] }]);
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel uploading a.txt" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
  });

  it("asks what to do about a file that is already there", () => {
    line([{ ...base, state: "waiting", items: [fileClash("i1", "a.txt")] }]);
    expect(screen.getByText(/is already in/)).toBeTruthy();
    for (const label of ["Replace", "Keep both", "Skip"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("answers through the store", () => {
    const { store } = line([{ ...base, state: "waiting", items: [fileClash("i1", "a.txt")] }]);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Skip" }))).not.toThrow();
    expect(store.getState().ops).toHaveLength(1);
  });

  it("offers no Replace when a folder is in the way", () => {
    line([{ ...base, state: "waiting", items: [folderClash("i1", "Photos")] }]);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep both" })).toBeTruthy();
    expect(screen.getByText(/A folder named/)).toBeTruthy();
  });

  it("offers Try again for a failure that can be retried", () => {
    line([
      {
        ...base,
        state: "partial",
        items: [{ id: "i1", name: "a.txt", state: "failed", retryable: true, offline: true, error: null }],
      },
    ]);
    expect(screen.getByText(/Couldn't reach Luna/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("shows Luna's own words for a failed copy and no Try again when it can't be retried", () => {
    line([
      {
        ...base,
        kind: "copy",
        state: "failed",
        items: [{ id: "i1", name: "big.iso", state: "failed", retryable: false, error: "Inbox is full. Free up some space on it and try again." }],
      },
    ]);
    expect(screen.getByText(/Inbox is full/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
