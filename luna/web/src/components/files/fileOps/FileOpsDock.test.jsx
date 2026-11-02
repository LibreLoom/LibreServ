import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import FileOpsDock from "./FileOpsDock.jsx";
import { fileClash, renderWithOps } from "./fileOpsTestUtils.jsx";

const upload = {
  id: "op1",
  kind: "upload",
  state: "running",
  title: "a.txt",
  destLabel: "Inbox",
  itemsTotal: 1,
  bytesTotal: 100,
  items: [{ id: "i1", name: "a.txt", state: "uploading", size: 100, received: 50 }],
};

describe("FileOpsDock", () => {
  it("renders nothing when there is no visible operation", () => {
    const { container } = renderWithOps(<FileOpsDock />, [
      { id: "q", kind: "trash", state: "running", shown: false, items: [] },
    ]);
    expect(container.querySelector("[data-slot='file-ops-dock']")).toBeNull();
    expect(screen.queryByRole("region", { name: "File tasks" })).toBeNull();
  });

  it("starts collapsed, showing the summary rather than the rows", () => {
    renderWithOps(<FileOpsDock />, [upload]);
    expect(screen.getByRole("region", { name: "File tasks" })).toBeTruthy();
    expect(screen.getByText("Working on your files")).toBeTruthy();
    expect(screen.getByText("Uploading 1 file · 50%")).toBeTruthy();
    // Collapsed means the rows are not up yet.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });

  it("expands to the rows and collapses again", async () => {
    renderWithOps(<FileOpsDock />, [upload]);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.getByText("Uploading 1 file · 50%")).toBeTruthy();
    // The rows leave on an exit animation, so they are still mounted for a
    // moment after the toggle. That is the point: they collapse, not vanish.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  it("says files need you when nothing runs and a problem is left", () => {
    renderWithOps(<FileOpsDock />, [
      { id: "op2", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "a.txt")] },
    ]);
    expect(screen.getByText("Some files need you")).toBeTruthy();
    // A problem does not unfold the card. The header says something is wrong;
    // the chevron is how you look.
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("stays collapsed even when a problem is already waiting", () => {
    // A new problem used to open the card by itself. Nothing may do that now:
    // someone reading the page decides when the details appear.
    renderWithOps(<FileOpsDock />, [
      { id: "op1", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "a.txt")] },
    ]);
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.getByText("Some files need you")).toBeTruthy();
  });

  it("insets the rows by the same amount on every edge", () => {
    // The header pads 12px; the rows sat 12px from the top but 20px from the
    // bottom and 8px apart, which read as a mistake. One value, all edges.
    const { container } = renderWithOps(<FileOpsDock />, [
      upload,
      { id: "op9", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c9", "z.txt")] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const header = container.querySelector("[data-slot='card'] > div");
    const scroller = container.querySelector(".overflow-y-auto");
    const row = container.querySelector("[data-slot='file-op-row']");
    expect(header.className).toContain("p-3");
    // The scroller must not add its own bottom padding: the last row's own
    // gap is the card's bottom edge.
    expect(scroller.className).toContain("px-3");
    expect(scroller.className).not.toContain("pb-");
    expect(row.parentElement.className).toBe("pb-3");
  });

  it("has no way to dismiss the whole card", () => {
    // One X that dropped every row could hide a failure nobody had read yet,
    // and it was irreversible. A finished row still clears itself, and an
    // answered problem still closes, so nothing is stuck.
    renderWithOps(<FileOpsDock />, [
      { id: "op2", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "a.txt")] },
    ]);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    // The row's own controls are still there once you look.
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  });

  it("says what finished instead of claiming files need you", () => {
    renderWithOps(<FileOpsDock />, [
      {
        id: "op3",
        kind: "upload",
        state: "done",
        endedAt: 1,
        itemsTotal: 2,
        itemsDone: 2,
        items: [
          { id: "a", name: "a.txt", state: "done" },
          { id: "b", name: "b.txt", state: "done" },
        ],
      },
    ]);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("2 files uploaded")).toBeTruthy();
    expect(screen.queryByText("Some files need you")).toBeNull();
  });

  it("summarizes running work and problems together when collapsed", () => {
    renderWithOps(<FileOpsDock />, [
      upload,
      { id: "op4", kind: "copy", state: "running", destLabel: "Inbox", itemsTotal: 2, bytesTotal: 10, items: [{ id: "x", name: "x", state: "running" }] },
      { id: "op5", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "z.txt")] },
    ]);
    expect(screen.getByText(/2 running/)).toBeTruthy();
    expect(screen.getByText(/1 need you/)).toBeTruthy();
  });

  it("keeps its header words while the last operation leaves", async () => {
    // The reported bug: dismissing the last row emptied `dockInfo`, so the
    // card collapsed to a blank bar, then vaporized. The header must still
    // say what it said while the card animates out.
    const { store } = renderWithOps(<FileOpsDock />, [upload]);
    expect(screen.getByText("Working on your files")).toBeTruthy();

    store.dismiss("op1");

    // The card is still on screen, saying what it was saying.
    expect(screen.getByRole("region", { name: "File tasks" })).toBeTruthy();
    expect(screen.getByText("Working on your files")).toBeTruthy();
    // And then it goes, without ever showing an empty header.
    await waitFor(() => expect(screen.queryByRole("region", { name: "File tasks" })).toBeNull());
  });

  it("outlines the card so it separates from the page behind it", () => {
    const { container } = renderWithOps(<FileOpsDock />, [upload]);
    const card = container.querySelector("[data-slot='card']");
    expect(card.className).toContain("border-accent");
  });

  it("keeps the card while one file's shape changes", async () => {
    const { store } = renderWithOps(<FileOpsDock />, [upload]);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("50%")).toBeTruthy();

    store.cancel("op1");

    // The running line leaves; the card stays put and says what happened.
    await waitFor(() => expect(screen.queryByText("50%")).toBeNull());
    expect(screen.getByRole("region", { name: "File tasks" })).toBeTruthy();
  });
});
