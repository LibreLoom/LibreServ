import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { BackupRowActions, VersionsModal } from "./backupsView.jsx";
import FileOpsDock from "./fileOps/FileOpsDock.jsx";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import { createFileOpsStore } from "../../lib/fileOps/store.js";
import PropertiesSheet from "./PropertiesSheet.jsx";
import { backupSegmentLabel, backupSource } from "./backupsSource.js";

const toasts = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
  ToastProvider: ({ children }) => children,
  useToast: () => toasts,
}));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const BACKUP = {
  id: "b1",
  source_name: "Trips",
  source_drive_name: "Photo drive",
  source_path: "Pictures/Trips",
  source_drive: "d2",
  status: "active",
  last_ok_at: 1_700_000_000,
  size_bytes: 2_500_000,
};

const LIST = [
  { name: "Holiday", is_dir: true, size: 0, mtime: 1_700_000_000 },
  { name: "cat.jpg", is_dir: false, size: 1200, mtime: 1_700_000_000 },
  { name: "old.txt", is_dir: false, size: 40, mtime: 1_690_000_000, deleted: true, deleted_at: 1_695_000_000 },
];

const VERSIONS = [
  { at: null, size: 1200, mtime: 1_700_000_000 },
  { at: 1_690_000_000, size: 1100, mtime: 1_690_000_000 },
];

function stubApi(opts = /** @type {{ restore?: () => Response }} */ ({})) {
  const { restore } = opts;
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method || "GET", body: init.body });
      if (u === "/api/v1/drives/d1/backups") return json([BACKUP]);
      if (u.startsWith("/api/v1/drives/d1/backups/b1/list")) return json(LIST);
      if (u.startsWith("/api/v1/drives/d1/backups/b1/versions")) return json(VERSIONS);
      if (u === "/api/v1/drives/d1/backups/b1/restore" && init.method === "POST") {
        return restore ? restore() : json({ name: "cat (2).jpg" });
      }
      return json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

const FILE = { backup: BACKUP, rel: "cat.jpg", name: "cat.jpg" };

function renderVersions() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <VersionsModal driveId="d1" backup={BACKUP} file={FILE} onClose={() => {}} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  toasts.addToast.mockClear();
});

describe("backup source", () => {
  it("lists the backups on the drive as folders at the Backups path", async () => {
    stubApi();
    const rows = await backupSource("d1").listDir("d1", ".luna-backups");
    expect(rows).toEqual([
      expect.objectContaining({ name: "b1", original_name: "Trips", kind: "dir", size: 2_500_000 }),
    ]);
  });

  it("lists what a backup holds, marking deleted files", async () => {
    stubApi();
    const rows = await backupSource("d1").listDir("d1", ".luna-backups/b1");
    expect(rows.map((r) => [r.original_name, r.kind])).toEqual([
      ["Holiday", "dir"],
      ["cat.jpg", "file"],
      ["old.txt (deleted)", "file"],
    ]);
  });

  it("points downloads at the backup", () => {
    expect(backupSource("d1").downloadHref("d1", ".luna-backups/b1/Holiday")).toBe(
      "/api/v1/drives/d1/backups/b1/download?path=Holiday",
    );
  });

  it("labels the crumbs with the backup's source folder", () => {
    const label = backupSegmentLabel([BACKUP], ".luna-backups/b1/Holiday");
    expect(["", "", ""].map((_, i) => label([".luna-backups", "b1", "Holiday"][i], i))).toEqual([
      "Backups",
      "Trips",
      "Holiday",
    ]);
  });
});

describe("VersionsModal", () => {
  it("opens the versions modal for a file", async () => {
    stubApi();
    renderVersions();

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Latest")).toBeInTheDocument();
    expect(await within(dialog).findAllByRole("button", { name: /Restore to original folder/ })).toHaveLength(2);
    expect(within(dialog).getByText(/Never replaces anything/)).toBeInTheDocument();
  });

  it("shows a success toast after a restore", async () => {
    const calls = stubApi();
    renderVersions();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click((await within(dialog).findAllByRole("button", { name: /Restore to original folder/ }))[0]);

    await waitFor(() =>
      expect(toasts.addToast).toHaveBeenCalledWith({
        type: "success",
        message: "Restored as cat (2).jpg.",
      }),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post.body)).toEqual({ path: "cat.jpg" });
  });

  it("shows the server sentence inline when restore returns 409", async () => {
    stubApi({
      restore: () => json({ error: "Connect Photo drive to restore this file." }, 409),
    });
    renderVersions();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click((await within(dialog).findAllByRole("button", { name: /Restore to original folder/ }))[1]);

    await waitFor(() =>
      expect(screen.getByText("Connect Photo drive to restore this file.")).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /Restore to original folder/ })).toHaveLength(2);
  });
});

describe("backup folder restore", () => {
  function renderRowActions() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createFileOpsStore({ queryClient, addToast: toasts.addToast, storage: null });
    const ctx = { fullPath: ".luna-backups/b1/Holiday", displayName: "Holiday", entry: { kind: "dir" } };
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <FileOpsProvider store={store}>
            <BackupRowActions driveId="d1" ctx={ctx} onVersions={() => {}} />
            <FileOpsDock />
          </FileOpsProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    return store;
  }

  it("hands the restore to the file task card and toasts once when it is done", async () => {
    const calls = stubApi();
    renderRowActions();
    fireEvent.click(screen.getByRole("button", { name: "Restore Holiday to original folder" }));

    await waitFor(() =>
      expect(toasts.addToast).toHaveBeenCalledWith({ type: "success", message: "Restored as cat (2).jpg." }),
    );
    expect(toasts.addToast).toHaveBeenCalledTimes(1);
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post.body)).toEqual({ path: "Holiday" });
  });

  it("keeps a failed restore in its card row instead of a toast", async () => {
    stubApi({ restore: () => json({ error: "Connect Photo drive to restore this file." }, 409) });
    renderRowActions();
    fireEvent.click(screen.getByRole("button", { name: "Restore Holiday to original folder" }));

    const dock = await screen.findByRole("region", { name: "File tasks" });
    expect(await within(dock).findByText("Connect Photo drive to restore this file.")).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(toasts.addToast).not.toHaveBeenCalled();
  });
});

describe("backup details sheet", () => {
  function renderSheet(path, entry) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <PropertiesSheet driveId="d1" driveLabel="Backup drive" path={path} entry={entry} onClose={() => {}} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  it("describes a backup from its own record", async () => {
    stubApi();
    const [row] = await backupSource("d1").listDir("d1", ".luna-backups");
    renderSheet(".luna-backups/b1", { ...row, name: "Trips" });
    expect(await screen.findByText("Folder backup")).toBeInTheDocument();
    expect(screen.getByText("Backup successful")).toBeInTheDocument();
    expect(screen.getByText("Backups on Backup drive")).toBeInTheDocument();
    expect(screen.getByText("Photo drive / Pictures / Trips")).toBeInTheDocument();
    expect(screen.getByText(/Earlier versions of changed files aren't counted/)).toBeInTheDocument();
  });

  it("describes a deleted file inside a backup", async () => {
    stubApi();
    const rows = await backupSource("d1").listDir("d1", ".luna-backups/b1");
    const old = rows.find((r) => r.name === "old.txt");
    renderSheet(".luna-backups/b1/old.txt", { ...old, name: "old.txt (deleted)" });
    expect(await screen.findByText("Deleted from the original")).toBeInTheDocument();
    expect(screen.getByText("Kept until")).toBeInTheDocument();
    expect(screen.getByText("Photo drive / Pictures / Trips / old.txt")).toBeInTheDocument();
    expect(screen.getByText("Backups on Backup drive / Trips")).toBeInTheDocument();
  });
});
