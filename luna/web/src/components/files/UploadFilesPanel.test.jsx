import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UploadFilesPanel from "./UploadFilesPanel.jsx";
import { LUNA_DRIVE_MIME, LUNA_PATHS_MIME } from "../../lib/dnd.js";

const file = (name = "a.txt") => new File(["x"], name, { type: "text/plain" });

/** A drop payload with plain files (no directory entries). */
function osDrop(files) {
  return {
    types: ["Files"],
    files,
    items: files.map((f) => ({ kind: "file", getAsFile: () => f, webkitGetAsEntry: () => null })),
    getData: () => "",
    dropEffect: "",
  };
}

function lunaDrop(paths, drive) {
  return {
    types: [LUNA_PATHS_MIME],
    files: [],
    items: [],
    getData: (type) => (type === LUNA_PATHS_MIME ? JSON.stringify(paths) : type === LUNA_DRIVE_MIME ? drive : ""),
    dropEffect: "",
  };
}

describe("UploadFilesPanel", () => {
  it("uploads what the file picker returns, then clears the picker", async () => {
    const onUploadFiles = vi.fn();
    render(<UploadFilesPanel onUploadFiles={onUploadFiles} />);
    const input = screen.getByLabelText("Add files");
    const picked = [file("a.txt"), file("b.txt")];
    fireEvent.change(input, { target: { files: picked } });
    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledWith(picked));
    expect(/** @type {HTMLInputElement} */ (input).value).toBe("");
  });

  it("uploads files dropped from the computer", async () => {
    const onUploadFiles = vi.fn();
    render(<UploadFilesPanel onUploadFiles={onUploadFiles} />);
    const zone = screen.getByText("Choose files or drop them here").parentElement;
    const f = file("drop.txt");
    fireEvent.drop(zone, { dataTransfer: osDrop([f]) });
    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledTimes(1));
    expect(onUploadFiles.mock.calls[0][0].map((x) => x.name)).toEqual(["drop.txt"]);
  });

  it("moves Luna's own dragged files instead of uploading them", async () => {
    const onUploadFiles = vi.fn();
    const onMovePaths = vi.fn();
    render(<UploadFilesPanel onUploadFiles={onUploadFiles} onMovePaths={onMovePaths} />);
    const zone = screen.getByText("Choose files or drop them here").parentElement;
    fireEvent.drop(zone, { dataTransfer: lunaDrop(["docs/a.txt"], "d1") });
    await waitFor(() => expect(onMovePaths).toHaveBeenCalledWith(["docs/a.txt"], "d1"));
    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it("ignores Luna drags when it cannot move them, and ignores drops while busy", async () => {
    const onUploadFiles = vi.fn();
    const { rerender } = render(<UploadFilesPanel onUploadFiles={onUploadFiles} />);
    const zone = () => screen.getByText("Choose files or drop them here").parentElement;
    fireEvent.drop(zone(), { dataTransfer: lunaDrop(["x"], "d1") });
    rerender(<UploadFilesPanel onUploadFiles={onUploadFiles} busy />);
    fireEvent.drop(zone(), { dataTransfer: osDrop([file()]) });
    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeDisabled();
  });

  it("accepts a drag only when it carries something it can use", () => {
    render(<UploadFilesPanel onUploadFiles={vi.fn()} onMovePaths={vi.fn()} />);
    const zone = screen.getByText("Choose files or drop them here").parentElement;
    expect(fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"] } })).toBe(true);
    expect(fireEvent.dragOver(zone, { dataTransfer: osDrop([]) })).toBe(false);
    expect(fireEvent.dragOver(zone, { dataTransfer: lunaDrop(["a"], "d") })).toBe(false);
  });

  it("shows the parent's error, or a plain one when the upload throws", async () => {
    const onUploadFiles = vi.fn().mockRejectedValue(new Error("Drive is full."));
    const { rerender } = render(<UploadFilesPanel onUploadFiles={onUploadFiles} />);
    fireEvent.change(screen.getByLabelText("Add files"), { target: { files: [file()] } });
    expect(await screen.findByText("Drive is full.")).toBeInTheDocument();
    rerender(<UploadFilesPanel onUploadFiles={onUploadFiles} error="Luna is out of room." />);
    expect(screen.getByText("Luna is out of room.")).toBeInTheDocument();
  });

  it("does nothing for an empty pick and passes accept through", () => {
    const onUploadFiles = vi.fn();
    render(<UploadFilesPanel onUploadFiles={onUploadFiles} accept="image/*" title="Add photos" />);
    expect(screen.getByLabelText("Add files")).toHaveAttribute("accept", "image/*");
    expect(screen.getByText("Add photos")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add files"), { target: { files: [] } });
    expect(onUploadFiles).not.toHaveBeenCalled();
  });
});
