import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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

  it("shows a running upload under 'Working on your files'", () => {
    renderWithOps(<FileOpsDock />, [upload]);
    expect(screen.getByRole("region", { name: "File tasks" })).toBeTruthy();
    expect(screen.getByText("Working on your files")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("collapses to a one-line summary and expands again", () => {
    renderWithOps(<FileOpsDock />, [upload]);
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.getByText("Uploading 1 file · 50%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("says files need you when nothing runs and a problem is left", () => {
    renderWithOps(<FileOpsDock />, [
      { id: "op2", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "a.txt")] },
    ]);
    expect(screen.getByText("Some files need you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("summarizes running work and problems together when collapsed", () => {
    renderWithOps(<FileOpsDock />, [
      upload,
      { id: "op3", kind: "copy", state: "running", destLabel: "Inbox", itemsTotal: 2, bytesTotal: 10, items: [{ id: "x", name: "x", state: "running" }] },
      { id: "op4", kind: "upload", state: "waiting", destLabel: "Inbox", items: [fileClash("c1", "z.txt")] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.getByText(/2 running/)).toBeTruthy();
    expect(screen.getByText(/1 need you/)).toBeTruthy();
  });
});
