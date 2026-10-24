import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import FileOpRow from "./FileOpRow.jsx";
import { fileClash, folderClash, renderWithOps } from "./fileOpsTestUtils.jsx";

function row(initialOps) {
  const result = renderWithOps(null, initialOps);
  const op = result.store.getState().ops[0];
  result.unmount();
  return renderWithOps(<div className="surface-secondary p-3"><FileOpRow op={op} /></div>, initialOps);
}

const base = { id: "op1", kind: "upload", destLabel: "Inbox" };

describe("FileOpRow", () => {
  it("shows one running upload with its status, meter and meta line", () => {
    row([
      {
        ...base,
        state: "running",
        title: "report.pdf",
        itemsTotal: 1,
        items: [{ id: "i1", name: "report.pdf", state: "uploading", size: 1000, received: 500 }],
      },
    ]);
    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows the first clash and a button for the other 14", () => {
    const items = Array.from({ length: 15 }, (_, i) => fileClash(`i${i}`, `f${i}.txt`));
    row([{ ...base, state: "waiting", items }]);
    expect(screen.getByText("f0.txt")).toBeTruthy();
    expect(screen.queryByText("f1.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "14 more problems →" }));
    expect(screen.getByText("Problems with this upload")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep both for all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip all" })).toBeTruthy();
  });

  it("offers no Replace for a folder clash", () => {
    row([{ ...base, state: "waiting", items: [folderClash("i1", "Photos")] }]);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More problems →" })).toBeNull();
  });

  it("shows Try again for an item that failed offline", () => {
    row([
      {
        ...base,
        state: "partial",
        itemsTotal: 2,
        itemsDone: 1,
        items: [
          { id: "a", name: "a.txt", state: "done" },
          { id: "b", name: "b.txt", state: "failed", retryable: true, offline: true },
        ],
      },
    ]);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("shows Luna's text for a failed copy", () => {
    row([
      {
        id: "op2",
        kind: "copy",
        state: "failed",
        title: "Movie.mkv",
        destLabel: "Backup",
        items: [
          {
            id: "i1",
            name: "Movie.mkv",
            state: "failed",
            retryable: true,
            error: "Backup is full. Free up some space on it and try again.",
          },
        ],
      },
    ]);
    expect(screen.getByText(/Backup is full/)).toBeTruthy();
    expect(screen.getByText(/Couldn't copy/)).toBeTruthy();
  });

  it("shows a moving bar for emptying the trash", async () => {
    row([{ id: "op3", kind: "empty-trash", state: "running", title: "Photos drive", destLabel: "Photos drive", indeterminate: true, itemsTotal: null, items: [] }]);
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("data-slot")).toBe("linear-progress");
    expect(screen.getByText(/Emptying Trash on/)).toBeTruthy();
  });
});
