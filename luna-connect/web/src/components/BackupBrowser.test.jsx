import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BackupBrowser } from "./BackupBrowser.jsx";
import { downloadBackup, fetchBackupBlob } from "../api.js";

vi.mock("../api.js", () => ({
  downloadBackup: vi.fn(),
  fetchBackupBlob: vi.fn(),
}));

const objects = [
  { device_id: "d1", relative_path: "Photos/album/beach.jpg", size: 2000, updated_at: 1700000000 },
  { device_id: "d1", relative_path: "Photos/a.jpg", size: 100, updated_at: 1700001000 },
  { device_id: "d1", relative_path: "notes.txt", size: 12, updated_at: 1700002000 },
];

describe("BackupBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadBackup.mockResolvedValue(undefined);
    fetchBackupBlob.mockResolvedValue(new Blob(["hello"], { type: "text/plain" }));
  });

  it("lists folders and files, then opens a folder", () => {
    render(<BackupBrowser objects={objects} onError={vi.fn()} />);
    expect(screen.getByTestId("backup-browser")).toBeTruthy();
    expect(screen.getByText("Current folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cloud backup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.queryByText("a.jpg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    expect(screen.getByText("a.jpg")).toBeTruthy();
    expect(screen.getByText("album")).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /↑ Up one folder/i }));
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download notes.txt" }).textContent).toBe("");
  });

  it("opens a file to check what it is and can download it", async () => {
    render(<BackupBrowser objects={objects} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
    expect(await screen.findByTestId("backup-preview")).toBeTruthy();
    expect(screen.getByText(/Text file/i)).toBeTruthy();
    await waitFor(() => {
      expect(fetchBackupBlob).toHaveBeenCalledWith("d1", "notes.txt");
    });
    expect(await screen.findByText("hello")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("backup-preview")).getByRole("button", { name: "Download notes.txt" }));
    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledWith("d1", "notes.txt");
    });
  });

  it("downloads all copies from the root", async () => {
    render(<BackupBrowser objects={objects} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Download all copies/i }));
    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledTimes(3);
    });
  });
});
