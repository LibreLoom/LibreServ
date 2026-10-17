import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** Routes the cloud API calls the card makes; anything else gets an empty object. */
function stubApi({ connected = true, cardOnFile = true, backups = [], runResponse = { done: true } } = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    if (url === "/api/v1/connect/status") return json({ connect_active: connected, card_on_file: cardOnFile });
    if (url === "/api/v1/cloud/backups" && method === "GET") return json(backups);
    if (url.endsWith("/run") && method === "POST") return json(runResponse);
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
  afterEach(() => vi.unstubAllGlobals());

  it("explains how to get started before this Luna is linked", async () => {
    stubApi({ connected: false });
    renderCard();
    expect(await screen.findByText(/Link this Luna to Luna Connect/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
  });

  it("asks for a payment card when this Luna is linked but no card is on file", async () => {
    stubApi({ connected: true, cardOnFile: false, backups: [] });
    renderCard();
    expect(await screen.findByText(/Add a payment card at Luna Connect/)).toBeInTheDocument();
    expect(screen.getByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is backed up to the cloud yet/)).toBeNull();
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

  it("lists each cloud backup with its size and actions", async () => {
    stubApi({ connected: true, backups: [sampleBackup] });
    renderCard();
    expect(await screen.findByText("Pictures")).toBeInTheDocument();
    expect(screen.getByText(/Family photos/)).toBeInTheDocument();
    expect(screen.getByText(/2(\.0)? GB in the cloud/)).toBeInTheDocument();
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
    expect(await screen.findByText(/This backup hasn't finished in over a day/)).toBeInTheDocument();
    expect(screen.getByText(/Luna copies files to the cloud every 6 hours/)).toBeInTheDocument();
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
