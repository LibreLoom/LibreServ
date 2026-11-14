import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { RESTORE_QUERY_KEY } from "../../../lib/cloudRestore";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** Routes the cloud API calls the card makes; anything else gets an empty object. */
function stubApi({
  connected = true,
  cardOnFile = true,
  backups = [],
  backupsError = null,
  onBackupsPending = null,
  onRestoreStatusPending = null,
  restoreStatus = /** @type {{needed: boolean, cloud_snapshots: number, indexed_snapshots: number, signing_public?: string}} */ ({
    needed: false,
    cloud_snapshots: 0,
    indexed_snapshots: 0,
  }),
  runResponse = /** @type {any} */ ({ done: true }),
  runError = null,
  runErrorStatus = 502,
  checkError = null,
  deleteError = null,
  restoreStatusError = null,
  phrase = /** @type {any} */ ({ set: false }),
} = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    if (url === "/api/v1/auth/status") return json({ has_admin: true, connect_active: connected });
    if (url === "/api/v1/connect/status") return json({ connect_active: connected, card_on_file: cardOnFile });
    if (url === "/api/v1/cloud/phrase" && method === "GET") return json(phrase);
    if (url === "/api/v1/cloud/restore" && method === "GET") {
      if (onRestoreStatusPending) {
        return new Promise((resolve) => onRestoreStatusPending((response = json(restoreStatus)) => resolve(response)));
      }
      const message = typeof restoreStatusError === "function" ? restoreStatusError() : restoreStatusError;
      if (message) {
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(restoreStatus);
    }
    if (url === "/api/v1/cloud/backups" && method === "GET") {
      if (onBackupsPending) {
        return new Promise((resolve) => onBackupsPending(() => resolve(json(backups))));
      }
      const message = typeof backupsError === "function" ? backupsError() : backupsError;
      if (message) {
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(backups);
    }
    if (/\/run(\?|$)/.test(url) && method === "POST") {
      if (runError) {
        return new Response(JSON.stringify({ error: runError }), {
          status: runErrorStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(runResponse);
    }
    if (url.endsWith("/check") && method === "POST") {
      if (checkError) {
        return new Response(JSON.stringify({ error: checkError }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({ done: true });
    }
    if (url.startsWith("/api/v1/cloud/backups/") && method === "DELETE") {
      if (deleteError) {
        return new Response(JSON.stringify({ error: deleteError }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({});
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <CloudBackupCategory />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const sampleBackup = {
  id: "b1",
  kind: "folder",
  source_drive: "drive-1",
  source_drive_name: "Family photos",
  source_path: "/Pictures",
  source_name: "Pictures",
  state: "ok",
  status: "active",
  stop_reason: "",
  last_ok_at: Math.floor(Date.now() / 1000) - 3600,
  last_error: "",
  size: 2147483648,
  can_delete: true,
  running: false,
};

describe("CloudBackupCategory", () => {
  afterEach(() => {
    mockRole = "admin";
    vi.unstubAllGlobals();
  });

  it("shows the recovery phrase card first, then the backup list", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    const phrase = await screen.findByText("Recovery phrase");
    const list = await screen.findByText("Cloud backup");
    expect(phrase.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stacks its cards in one spaced wrapper, like the other settings categories", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    await screen.findByRole("heading", { name: "Cloud backup" });

    const wrapper = document.querySelector("[data-slot='cloud-backup-category']");
    expect(wrapper).toBeTruthy();
    // Same wrapper the sibling categories use (About, Devices, Appearance).
    expect(wrapper.className).toMatch(/\bspace-y-4\b/);

    // Both cards live inside it, in order, and nothing else does.
    const cards = Array.from(wrapper.children);
    expect(cards.length).toBe(2);
    for (const card of cards) expect(card.getAttribute("data-settings-item")).toBe("card");
    expect(wrapper.children[0].textContent).toMatch(/Recovery phrase/);
    expect(wrapper.children[1].textContent).toMatch(/Cloud backup/);
  });

  it("keeps the delete confirmation out of the card layout wrapper", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete cloud backup?" });
    expect(dialog).toBeInTheDocument();

    // The modal portals to body, so it must not land inside the spaced wrapper —
    // and the wrapper still holds only its cards, so the gap never wraps a modal.
    const wrapper = document.querySelector("[data-slot='cloud-backup-category']");
    expect(wrapper).toBeTruthy();
    expect(wrapper.contains(dialog)).toBe(false);
    expect(wrapper.children.length).toBe(2);
  });

  it("puts the lost-phrase section in the pill variant, like the other categories", async () => {
    stubApi({
      connected: true,
      backups: [sampleBackup],
      phrase: { set: true, set_at: 1_700_000_000, last_checked_at: 1_700_500_000, luna_id: "luna-1", phrase_words: 12 },
    });
    renderCard();

    const toggle = await screen.findByRole("button", { name: "Lost your recovery phrase?" });
    // Mono: the toggle label wears the heading face, as in Update source and Open source licenses.
    expect(toggle.className).toMatch(/\bfont-mono\b/);
    // Pill: only the pill variant puts an outline on the section wrapper.
    const section = toggle.closest("[data-slot='collapsible']");
    expect(section).toBeTruthy();
    expect(section.className).toMatch(/\brounded-large-element\b/);
    expect(section.className).toMatch(/\bborder\b/);
  });

  it("does not include the Luna Connect card", async () => {
    stubApi({ connected: true });
    renderCard();
    await screen.findByText("Cloud backup");
    expect(screen.queryByText("Open Luna Connect")).toBeNull();
  });

  it("with Connect off, an Admin sees the phrase card and a line pointing at the device token, with no list", async () => {
    const fetchMock = stubApi({ connected: false });
    renderCard();
    expect(await screen.findByText(/Add your device token in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Advanced/ })).toHaveAttribute("href", "/settings#about");
    expect(screen.getByText("Recovery phrase")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked).not.toContain("/api/v1/cloud/backups");
    expect(asked).not.toContain("/api/v1/connect/status");
  });

  it("with Connect off, a Member is told an Admin can turn it on", async () => {
    mockRole = "member";
    stubApi({ connected: false });
    renderCard();
    expect(await screen.findByText("Cloud backup needs Luna Connect. An Admin can turn it on.")).toBeInTheDocument();
    expect(screen.getByText("Recovery phrase")).toBeInTheDocument();
  });

  it("with Connect off, leaves out the restore cards", async () => {
    stubApi({ connected: false });
    renderCard();
    await screen.findByText(/Cloud backup needs Luna Connect/);
    expect(screen.queryByText(/Bring back/i)).toBeNull();
  });

  it("asks for a payment card when this Luna is linked but no card is on file", async () => {
    stubApi({ connected: true, cardOnFile: false, backups: [] });
    renderCard();
    expect(await screen.findByText(/Add a payment card at Luna Connect/)).toBeInTheDocument();
    expect(screen.getByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
  });

  it("offers Back up anyway when a run says the source looks missing, and sends accept_missing", async () => {
    const fetchMock = stubApi({
      connected: true,
      backups: [sampleBackup],
      runResponse: { done: false, problem: "Luna cannot find this folder on the drive.", source_missing: true },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Luna cannot find this folder on the drive.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back up anyway" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/cloud/backups/b1/run?accept_missing=true",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("does not offer Back up anyway for a normal run problem", async () => {
    stubApi({
      connected: true,
      backups: [sampleBackup],
      runResponse: { done: false, problem: "The drive is full." },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("The drive is full.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up anyway" })).toBeNull();
  });

  it("keeps listed backups visible and asks for a card when none is on file", async () => {
    stubApi({ connected: true, cardOnFile: false, backups: [sampleBackup] });
    renderCard();
    expect(await screen.findByText("Pictures")).toBeInTheDocument();
    expect(screen.getByText(/Backups stay paused until then/)).toBeInTheDocument();
  });

  it("describes the 6-hour copy schedule and the kept versions", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    expect(await screen.findByText(/every 6 hours/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What cloud backup means" }));
    expect(await screen.findByText(/about one older copy from each of the last day, week and month/)).toBeInTheDocument();
  });

  it("says nothing is backed up yet when connected with no backups", async () => {
    stubApi({ connected: true, backups: [] });
    renderCard();
    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
  });

  it("waits for the backup list before saying that nothing is backed up", async () => {
    /** @type {(() => void)|null} */
    let finishBackups = null;
    stubApi({
      connected: true,
      backups: [],
      onBackupsPending: (finish) => { finishBackups = finish; },
    });
    renderCard();

    expect(await screen.findByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
    expect(await screen.findByText("Checking cloud backups…")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();

    await act(async () => finishBackups?.());
    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
  });

  it("shows progress while the Admin restore status is loading", async () => {
    /** @type {(() => void)|null} */
    let finishRestoreStatus = null;
    stubApi({
      connected: true,
      backups: [],
      onRestoreStatusPending: (finish) => { finishRestoreStatus = finish; },
    });
    renderCard();

    expect(await screen.findByText("Checking cloud backup status…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();

    await act(async () => finishRestoreStatus?.());
    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
  });

  it("offers a retry when the Admin restore status cannot be checked", async () => {
    let shouldFail = true;
    const fetchMock = stubApi({
      connected: true,
      backups: [],
      restoreStatusError: () => (shouldFail ? "Internal database details" : null),
    });
    renderCard();

    expect(await screen.findByText("Luna couldn't check cloud backup status.")).toBeInTheDocument();
    expect(screen.queryByText("Internal database details")).toBeNull();
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/cloud/restore")).toHaveLength(2);
  });

  it("does not queue another restore-status retry while one is in flight", async () => {
    /** @type {((response?: Response) => void)|null} */
    let finishRetry = null;
    let restoreRequests = 0;
    const fetchMock = stubApi({
      connected: true,
      backups: [],
      onRestoreStatusPending: (finish) => {
        restoreRequests += 1;
        if (restoreRequests === 1) {
          finish();
        } else if (restoreRequests === 2) {
          finish(new Response(JSON.stringify({ error: "temporary failure" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }));
        } else {
          finishRetry = finish;
        }
      },
    });
    const { client } = renderCard();

    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
    await act(async () => client.invalidateQueries({ queryKey: RESTORE_QUERY_KEY }));

    expect(await screen.findByText("Luna couldn't check cloud backup status.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/cloud/restore")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/cloud/restore")).toHaveLength(3);

    await act(async () => finishRetry?.());
    expect(await screen.findByText(/Nothing is backed up to the cloud yet/)).toBeInTheDocument();
  });

  it("shows a retry when the backup list fails instead of treating Members as empty", async () => {
    mockRole = "member";
    let shouldFail = true;
    const fetchMock = stubApi({
      connected: true,
      backups: [],
      backupsError: () => (shouldFail ? "Internal database details" : null),
    });
    renderCard();

    expect(await screen.findByText("Luna couldn't load cloud backups.")).toBeInTheDocument();
    expect(screen.queryByText("Internal database details")).toBeNull();
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();
    expect(screen.getByText("An Admin can check whether Luna has backups stored in the cloud.")).toBeInTheDocument();

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("An Admin can check whether Luna has backups stored in the cloud.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/cloud/backups")).toHaveLength(2);
  });

  it("does not make a whole-cloud empty claim for Members who cannot load restore status", async () => {
    mockRole = "member";
    const fetchMock = stubApi({ connected: true, backups: [] });
    renderCard();

    expect(await screen.findByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
    await waitFor(() => expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/v1/cloud/backups"),
    ).toBe(true));
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();
    expect(screen.getByText("An Admin can check whether Luna has backups stored in the cloud.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("/api/v1/cloud/restore");
  });

  it("uses safe fallback messages when checking or deleting a backup fails on the server", async () => {
    stubApi({
      connected: true,
      backups: [sampleBackup],
      checkError: "Internal database details",
      deleteError: "Proxy connection string",
    });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("Luna couldn't check this backup. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Internal database details")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete cloud backup" }));
    expect(await screen.findByText("Luna couldn't delete this backup. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Proxy connection string")).toBeNull();
  });

  it("does not show the cloud empty claim while restore status fails", async () => {
    stubApi({ connected: true, backups: [], restoreStatusError: "Internal database details" });
    renderCard();

    expect(await screen.findByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull());
  });

  it("does not call cloud backup empty when restore status has unindexed cloud versions", async () => {
    stubApi({
      connected: true,
      backups: [],
      restoreStatus: { needed: true, cloud_snapshots: 14, indexed_snapshots: 0, signing_public: "test-public-key" },
    });
    renderCard();

    expect(await screen.findByText((_, element) =>
      element?.tagName === "P" && element.textContent.includes("14 versions are in the cloud"),
    )).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();
  });

  it("lists each cloud backup with its size and actions", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    expect(await screen.findByText("Pictures")).toBeInTheDocument();
    expect(screen.getByText(/Family photos/)).toBeInTheDocument();
    expect(screen.getByText(/2\.1 GB in the cloud/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("says when a cloud backup has stopped finishing", async () => {
    stubApi({
      connected: true,
      backups: [{ ...sampleBackup, state: "stale", last_ok_at: 0 }],
    });
    renderCard();
    expect(await screen.findByText(/Luna copies files to the cloud every 6 hours/)).toBeInTheDocument();
    // The status pill and the notice line both say when the last copy finished.
    expect(screen.getAllByText("Not backed up yet.").length).toBeGreaterThan(0);
  });

  it("runs a backup through the new run route", async () => {
    const fetchMock = stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/cloud/backups/b1/run",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("keeps a failed start separate from the backup's last successful status", async () => {
    const message = "Internal database details";
    const fetchMock = stubApi({ connected: true, backups: [sampleBackup], runError: message, runErrorStatus: 500 });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    const card = (await screen.findByText("Pictures")).closest('[data-slot="backup-item"]');
    if (!(card instanceof HTMLElement)) throw new Error("Expected Pictures backup card");
    const notice = await within(card).findByText("Luna couldn't start this backup. Try again.");
    expect(within(card).queryByText(message)).toBeNull();
    expect(notice.closest('[data-slot="backup-item"]')).toBe(card);
    expect(within(card).getByText("Backup successful")).toBeInTheDocument();
    expect(within(card).queryByText("Last copy failed")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/cloud/backups/b1/run",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears a run problem when refreshed backup data confirms a newer successful copy", async () => {
    const message = "The cloud connection was interrupted.";
    const list = [sampleBackup];
    stubApi({ connected: true, backups: list, runResponse: { problem: message } });
    const { client } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText(message)).toBeInTheDocument();

    list[0] = { ...sampleBackup, state: "ok", last_ok_at: sampleBackup.last_ok_at + 60 };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["cloud-backups"] });
    });

    await waitFor(() => expect(screen.queryByText(message)).toBeNull());
    const card = screen.getByText("Pictures").closest('[data-slot="backup-item"]');
    if (!(card instanceof HTMLElement)) throw new Error("Expected Pictures backup card");
    expect(within(card).getByText("Backup successful")).toBeInTheDocument();
    expect(within(card).queryByText("Last copy failed")).toBeNull();
  });

  it("does not say an active failing backup has stopped after a run error", async () => {
    const message = "The cloud connection was interrupted.";
    stubApi({
      connected: true,
      backups: [{ ...sampleBackup, state: "failing", last_error: message }],
      runResponse: { problem: message },
    });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    const card = (await screen.findByText("Pictures")).closest('[data-slot="backup-item"]');
    if (!(card instanceof HTMLElement)) throw new Error("Expected Pictures backup card");
    expect(await within(card).findByText(message)).toBeInTheDocument();
    expect(within(card).queryByText("This cloud backup has stopped.")).toBeNull();
    expect(within(card).queryByText(/Luna copies files to the cloud every 6 hours/)).toBeNull();
  });

  it("asks before deleting and then calls the delete route", async () => {
    const fetchMock = stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete cloud backup?")).toBeInTheDocument();
    expect(screen.getByText(/including all earlier versions/)).toBeInTheDocument();
    expect(screen.getByText(/Everyone with access to this backup loses it/)).toBeInTheDocument();
    expect(screen.getByText(/The original files stay/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete cloud backup" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/cloud/backups/b1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
