import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import FormatPreview from "./FormatPreview.jsx";

// Panels sit on a card, as inside the erase window.
const onCard = (ui) => render(<div className="surface-secondary text-primary p-4">{ui}</div>);

const device = { name: "sdb", model: "SanDisk USB stick", size_bytes: 32_000_000_000, serial: "ABC123" };

describe("FormatPreview", () => {
  it("lists names, counts and space used", () => {
    onCard(<FormatPreview preview={{
      device, empty: false, blank: false, used_bytes: 5_000_000_000,
      partitions: [{
        name: "sdb1", size_bytes: 32_000_000_000, label: "BACKUP", state: "has_files", used_bytes: 5_000_000_000,
        folders: 1, files: 20, unreadable: 1, entries: [{ name: "Photos", kind: "folder" }, { name: "a.txt", kind: "file" }],
      }],
    }} />);
    expect(screen.getByText("BACKUP")).toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText(/1 folder, 20 files, 5\.0 GB used/)).toBeInTheDocument();
    expect(screen.getByText(/and 19 more/)).toBeInTheDocument();
    expect(screen.getByText(/1 item couldn't be read/)).toBeInTheDocument();
    // The system name and serial sit one step in, behind the ⓘ.
    expect(screen.queryByText("ABC123")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Which drive is this?" }));
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("sdb")).toBeInTheDocument();
  });

  it("hides Luna's own thumbnail folders from the names but still counts them", () => {
    onCard(<FormatPreview preview={{
      device, empty: false, blank: false, used_bytes: 1,
      partitions: [{
        name: "sdb1", size_bytes: 1, label: "", state: "has_files", used_bytes: 1, folders: 2, files: 0, unreadable: 0,
        entries: [{ name: ".luna-b6e985d9-thumbs", kind: "folder" }, { name: "Documents", kind: "folder" }],
      }],
    }} />);
    expect(screen.queryByText(/\.luna-/)).toBeNull();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
    // One unnamed part: no "Part 1" header repeating the drive.
    expect(screen.queryByText(/Part 1/)).toBeNull();
  });

  it("says a blank drive is blank", () => {
    onCard(<FormatPreview preview={{ device, empty: true, blank: true, partitions: [], used_bytes: null }} />);
    expect(screen.getByText("This drive is blank.")).toBeInTheDocument();
  });

  it("says a drive with only system leftovers is empty", () => {
    onCard(<FormatPreview preview={{ device, empty: true, blank: false, used_bytes: 0, partitions: [{ name: "sdb1", size_bytes: 1, label: "", state: "empty", used_bytes: 0, folders: 0, files: 0, unreadable: 0, entries: [] }] }} />);
    expect(screen.getByText("This drive is empty.")).toBeInTheDocument();
    expect(screen.getByText("Nothing on this part.")).toBeInTheDocument();
  });
});
