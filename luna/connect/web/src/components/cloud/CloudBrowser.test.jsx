import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CloudBrowser } from "./CloudBrowser.jsx";
import { loadTree } from "../../lib/cloudUnlock.js";
import { downloadFile, downloadFolder } from "../../lib/cloudDownload.js";

vi.mock("../../lib/cloudUnlock.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadTree: vi.fn(),
}));

vi.mock("../../lib/cloudDownload.js", () => ({
  downloadFile: vi.fn(),
  downloadFolder: vi.fn(),
}));

const SOURCE = { getPack: vi.fn() };

const ENTRIES = [
  { path: "Photos/cat.jpg", size: 2000, mtime: 1700000000, chunks: [] },
  { path: "Photos/trips/beach.jpg", size: 3000, mtime: 1700000100, chunks: [] },
  { path: "notes.txt", size: 10, mtime: 1700000200, chunks: [] },
];

function makeBackup(overrides = {}) {
  return {
    protectionId: "p1",
    name: "Photos",
    startedBy: "u1",
    startedByName: "Alex",
    keys: { 1: { key: "k", dedupKey: "d" } },
    versions: [
      { snapshotId: "v2", createdAt: 1700000500, treePackId: "t2", keyVersion: 1 },
      { snapshotId: "v1", createdAt: 1700000000, treePackId: "t1", keyVersion: 1 },
    ],
    ...overrides,
  };
}

describe("CloudBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTree.mockResolvedValue(ENTRIES);
  });

  it("shows a message when there are no backups", () => {
    render(<CloudBrowser source={SOURCE} backups={[]} />);
    expect(screen.getByText("No backups here yet.")).toBeTruthy();
  });

  it("groups backups by who started them and renders the group and row actions", () => {
    const backups = [
      makeBackup(),
      makeBackup({ protectionId: "p2", name: "Work", versions: [{ snapshotId: "w1", createdAt: 1700000000, treePackId: "tw", keyVersion: 1 }] }),
    ];
    render(
      <CloudBrowser
        source={SOURCE}
        backups={backups}
        groupActions={(group) => <button type="button">Group {group.name}</button>}
        backupActions={(backup) => <button type="button">Extra {backup.name}</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Alex" })).toBeTruthy();
    expect(screen.getByText("2 versions", { exact: false })).toBeTruthy();
    expect(screen.getByText("1 version", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Group Alex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Extra Photos" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);
  });

  it("opens a backup, lists its folders and files, and goes back", async () => {
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("combobox", { name: "Version" })).toBeTruthy();
    expect(screen.getByText("Opening this version…")).toBeTruthy();

    expect(await screen.findByRole("button", { name: "Photos" })).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(loadTree).toHaveBeenCalledWith(SOURCE, expect.objectContaining({ protectionId: "p1" }), expect.objectContaining({ snapshotId: "v2" }));

    fireEvent.click(screen.getByRole("button", { name: "Back to all backups" }));
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("moves into a folder and downloads it as a zip", async () => {
    downloadFolder.mockResolvedValue(undefined);
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Photos" }));
    expect(screen.getByRole("button", { name: "Download this folder" }).disabled).toBe(false);
    expect(screen.getByText("cat.jpg")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download this folder" }));
    await waitFor(() =>
      expect(downloadFolder).toHaveBeenCalledWith(SOURCE, expect.objectContaining({ protectionId: "p1" }), expect.objectContaining({ snapshotId: "v2" }), ENTRIES, "Photos"),
    );
  });

  it("downloads a single file from the list", async () => {
    downloadFile.mockResolvedValue(undefined);
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const row = (await screen.findByText("notes.txt")).closest(".rounded-large-element");
    fireEvent.click(within(row).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(SOURCE, expect.anything(), expect.anything(), expect.objectContaining({ path: "notes.txt" })));
  });

  it("reloads the tree when another version is picked", async () => {
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("notes.txt");
    fireEvent.change(screen.getByRole("combobox", { name: "Version" }), { target: { value: "1" } });
    await waitFor(() => expect(loadTree).toHaveBeenCalledWith(SOURCE, expect.anything(), expect.objectContaining({ snapshotId: "v1" })));
  });

  it("shows an inline error when the version cannot be opened", async () => {
    loadTree.mockRejectedValue(new Error("This version could not be opened."));
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This version could not be opened.");
  });

  it("shows an inline error when a download fails", async () => {
    downloadFile.mockRejectedValue(new Error("Could not decrypt this file."));
    render(<CloudBrowser source={SOURCE} backups={[makeBackup()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const row = (await screen.findByText("notes.txt")).closest(".rounded-large-element");
    fireEvent.click(within(row).getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not decrypt this file.");
  });
});
