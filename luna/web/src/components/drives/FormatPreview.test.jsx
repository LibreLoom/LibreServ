import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText("ABC123")).toBeInTheDocument();
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
