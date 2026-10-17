import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import BackupsFolder from "./BackupsFolder.jsx";

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

function renderFolder() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BackupsFolder driveId="d1" onExit={() => {}} />
        </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  toasts.addToast.mockClear();
});

describe("BackupsFolder", () => {
  it("lists the backups stored on this drive", async () => {
    stubApi();
    renderFolder();

    expect(await screen.findByText("Trips")).toBeInTheDocument();
    expect(screen.getByText("Photo drive")).toBeInTheDocument();
    expect(screen.getByText(/Last good copy/)).toBeInTheDocument();
  });

  it("opens a backup and shows its contents with a Deleted pill", async () => {
    stubApi();
    renderFolder();

    fireEvent.click(await screen.findByRole("button", { name: /Trips/ }));

    expect(await screen.findByText("Holiday")).toBeInTheDocument();
    expect(screen.getByText("cat.jpg")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText(/Kept until/)).toBeInTheDocument();
  });

  it("opens the versions modal for a file", async () => {
    stubApi();
    renderFolder();

    fireEvent.click(await screen.findByRole("button", { name: /Trips/ }));
    fireEvent.click(await screen.findByRole("button", { name: /cat\.jpg/ }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Latest")).toBeInTheDocument();
    expect(await within(dialog).findAllByRole("button", { name: /Restore to original folder/ })).toHaveLength(2);
    expect(within(dialog).getByText(/Never replaces anything/)).toBeInTheDocument();
  });

  it("shows a success toast after a restore", async () => {
    const calls = stubApi();
    renderFolder();

    fireEvent.click(await screen.findByRole("button", { name: /Trips/ }));
    fireEvent.click(await screen.findByRole("button", { name: /cat\.jpg/ }));
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
    renderFolder();

    fireEvent.click(await screen.findByRole("button", { name: /Trips/ }));
    fireEvent.click(await screen.findByRole("button", { name: /cat\.jpg/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click((await within(dialog).findAllByRole("button", { name: /Restore to original folder/ }))[1]);

    await waitFor(() =>
      expect(screen.getByText("Connect Photo drive to restore this file.")).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /Restore to original folder/ })).toHaveLength(2);
  });
});
