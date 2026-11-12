import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
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
  restoreStatus = /** @type {{needed: boolean, cloud_snapshots: number, indexed_snapshots: number, signing_public?: string}} */ ({
    needed: false,
    cloud_snapshots: 0,
    indexed_snapshots: 0,
  }),
  runResponse = /** @type {any} */ ({ done: true }),
  runError = null,
  phrase = /** @type {any} */ ({ set: false }),
} = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    if (url === "/api/v1/auth/status") return json({ has_admin: true, connect_active: connected });
    if (url === "/api/v1/connect/status") return json({ connect_active: connected, card_on_file: cardOnFile });
    if (url === "/api/v1/cloud/phrase" && method === "GET") return json(phrase);
    if (url === "/api/v1/cloud/restore" && method === "GET") return json(restoreStatus);
    if (url === "/api/v1/cloud/backups" && method === "GET") return json(backups);
    if (/\/run(\?|$)/.test(url) && method === "POST") {
      if (runError) {
        return new Response(JSON.stringify({ error: runError }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(runResponse);
    }
    if (url.endsWith("/check") && method === "POST") return json({ done: true });
    if (url.startsWith("/api/v1/cloud/backups/") && method === "DELETE") return json({});
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CloudBackupCategory />
      </ToastProvider>
    </QueryClientProvider>,
  );
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
    expect(
      await screen.findByText("Cloud backup needs Luna Connect. Add your device token in Settings → About → Advanced."),
    ).toBeInTheDocument();
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
    expect(screen.getByText(/costs \$8 per terabyte each month/)).toBeInTheDocument();
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

  it("shows a failed run on its backup card and replaces the stale success status", async () => {
    const message = "Luna Connect couldn't be reached. Check your internet connection and try again.";
    const fetchMock = stubApi({ connected: true, backups: [sampleBackup], runError: message });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    const card = (await screen.findByText("Pictures")).closest('[data-slot="backup-item"]');
    if (!(card instanceof HTMLElement)) throw new Error("Expected Pictures backup card");
    const notice = await within(card).findByText(message);
    expect(notice.closest('[data-slot="backup-item"]')).toBe(card);
    expect(within(card).getByText("Last copy failed")).toBeInTheDocument();
    expect(within(card).queryByText("Backup successful")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/cloud/backups/b1/run",
      expect.objectContaining({ method: "POST" }),
    );
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
