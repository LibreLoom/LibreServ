import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import FileOpProblemsModal from "./FileOpProblemsModal.jsx";
import { fileClash, folderClash, renderWithOps } from "./fileOpsTestUtils.jsx";

const noop = () => {};
const base = { id: "op1", kind: "upload", state: "waiting", destLabel: "Inbox" };

describe("FileOpProblemsModal", () => {
  it("lists every clash with the bulk buttons", () => {
    const items = Array.from({ length: 15 }, (_, i) => fileClash(`i${i}`, `f${i}.txt`));
    renderWithOps(<FileOpProblemsModal opId="op1" open onClose={noop} />, [{ ...base, items }]);
    expect(screen.getByText("Problems with this upload")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Skip" })).toHaveLength(15);
    for (const label of ["Replace all", "Keep both for all", "Skip all"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByText("Applies to the rest of this upload too.")).toBeTruthy();
  });

  it("hides Replace all when only folders are in the way", () => {
    renderWithOps(<FileOpProblemsModal opId="op1" open onClose={noop} />, [
      { ...base, items: [folderClash("a", "Photos"), folderClash("b", "Music")] },
    ]);
    expect(screen.queryByRole("button", { name: "Replace all" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep both for all" })).toBeTruthy();
  });

  it("offers Try all again and Clear failed for failures", () => {
    renderWithOps(<FileOpProblemsModal opId="op1" open onClose={noop} />, [
      {
        ...base,
        kind: "copy",
        state: "partial",
        items: [
          { id: "a", name: "a.txt", state: "failed", retryable: true, error: "Luna couldn't copy this. Try again." },
          { id: "b", name: "b.txt", state: "failed", retryable: true, error: "Luna couldn't copy this. Try again." },
        ],
      },
    ]);
    expect(screen.getByText("Problems with this copy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try all again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear failed" })).toBeTruthy();
  });
});
