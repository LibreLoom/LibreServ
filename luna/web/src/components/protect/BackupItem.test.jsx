import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import BackupItem from "./BackupItem.jsx";
import RestoreForm from "../cloud/RestoreForm.jsx";

const drive = {
  kind: "drive",
  source_name: "Photos",
  source_path: "photos",
  destination: "Backup drive",
  status: "active",
  state: "ok",
  last_ok_at: Date.now() / 1000 - 300,
  private: true,
};

describe("BackupItem", () => {
  it.each(["primary", "secondary"])("shows name, status, place and last copy on a %s surface", (surface) => {
    render(
      <div className={surface === "primary" ? "surface-secondary" : "surface-primary"}>
        <BackupItem backup={drive} surface={/** @type {any} */ (surface)} note={<p>A note</p>} />
      </div>,
    );
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("Folder backup")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("Backup drive")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Last copy 5 min ago")).toBeInTheDocument();
    expect(screen.getByText("A note")).toBeInTheDocument();
  });
});

describe("RestoreForm", () => {
  it("renders the phrase box and disables submit while empty", () => {
    render(
      <div className="surface-secondary">
        <RestoreForm words="" onWords={() => {}} onSubmit={() => {}} submitLabel="Find" error="Nope" />
      </div>,
    );
    expect(screen.getByLabelText("Recovery phrase")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find" })).toBeDisabled();
    expect(screen.getByText("Nope")).toBeInTheDocument();
  });
});
