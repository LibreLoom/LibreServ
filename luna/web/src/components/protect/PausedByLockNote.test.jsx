import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PausedByLockNote from "./PausedByLockNote.jsx";
import BackupItem from "./BackupItem.jsx";

// The note sits in a row on the page background, as BackupItem draws it on a card.
const onPage = (ui) => render(<div className="surface-primary text-secondary p-4">{ui}</div>);

describe("PausedByLockNote", () => {
  it("names the one locked drive", () => {
    onPage(<PausedByLockNote backup={{ paused: "locked", locked_drive_names: ["Photos"] }} />);
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText(/Paused until/)).toHaveTextContent("Paused until Photos is unlocked.");
  });

  it("names two", () => {
    onPage(<PausedByLockNote backup={{ paused: "locked", locked_drive_names: ["Photos", "Backup"] }} />);
    expect(screen.getByText(/Paused until/)).toHaveTextContent("Paused until Photos and Backup are unlocked.");
  });

  it("says nothing for a backup that isn't paused", () => {
    const { container } = onPage(<PausedByLockNote backup={{ paused: null, locked_drive_names: [] }} />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("shows on a backup row with a Paused pill", () => {
    render(
      <div className="surface-secondary text-primary p-4">
        <BackupItem backup={{ id: "b1", kind: "drive", source_name: "Photos", destination: "Backup", status: "active", state: "failing", paused: "locked", locked_drive_names: ["Backup"], last_ok_at: 0 }} />
      </div>,
    );
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText(/Paused until/)).toBeInTheDocument();
  });
});
