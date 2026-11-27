import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import FolderPickerModal from "./FolderPickerModal.jsx";
import { AuthProvider } from "../../context/AuthContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

describe("FolderPickerModal", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  function renderModal(props = {}) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FolderPickerModal
            open
            title="Move files"
            drives={[
              { id: "d1", label: "Drive 1", state: "healthy" },
              { id: "d2", label: "Drive 2", state: "healthy" },
            ]}
            initialDriveId="d1"
            confirmLabel="Start moving"
            onClose={vi.fn()}
            onConfirm={vi.fn()}
            {...props}
          />
        </MemoryRouter>
      </QueryClientProvider>
      </ToastProvider>,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the destination drive selector as a dropdown", async () => {
    renderModal({
      drives: [
        { id: "d1", label: "Drive 1", state: "healthy" },
        { id: "d2", label: "Drive 2", state: "healthy" },
        { id: "d3", label: "Drive 3", state: "healthy" },
      ],
    });

    expect(await screen.findByText("Destination drive")).toBeInTheDocument();
    const dropdownTrigger = document.querySelector('[data-slot="dropdown-trigger"]');
    expect(dropdownTrigger).toBeInTheDocument();
    fireEvent.click(dropdownTrigger);

    expect(await screen.findByRole("option", { name: /Drive 1 \(current\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Drive 2$/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Drive 3$/i })).toBeInTheDocument();
  });

  it("renders every drive in the dropdown (supporting 10+ drives gracefully)", async () => {
    const twelveDrives = Array.from({ length: 12 }, (_, i) => ({
      id: `d${i + 1}`,
      label: `Drive ${i + 1}`,
      state: "healthy",
    }));

    renderModal({
      drives: twelveDrives,
      initialDriveId: "d1",
    });

    expect(await screen.findByText("Destination drive")).toBeInTheDocument();
    const dropdownTrigger = document.querySelector('[data-slot="dropdown-trigger"]');
    expect(dropdownTrigger).toBeInTheDocument();

    // Click dropdown trigger to open options
    fireEvent.click(dropdownTrigger);

    // All 12 drives should be rendered in the dropdown options
    expect(await screen.findByRole("option", { name: "Drive 12" })).toBeInTheDocument();
  });

  it("filters out missing, ejected, failed, and readonly drives", async () => {
    renderModal({
      drives: [
        { id: "d1", label: "Drive 1", state: "as_is" },
        { id: "d2", label: "Drive 2", state: "as_is" },
        { id: "d3", label: "Unplugged", state: "missing" },
        { id: "d4", label: "Ejected Drive", state: "ejected" },
        { id: "d5", label: "Broken Drive", state: "failed" },
        { id: "d6", label: "Read Only", state: "readonly" },
      ],
    });

    expect(await screen.findByText("Destination drive")).toBeInTheDocument();
    const dropdownTrigger = document.querySelector('[data-slot="dropdown-trigger"]');
    expect(dropdownTrigger).toBeInTheDocument();
    fireEvent.click(dropdownTrigger);

    expect(await screen.findByRole("option", { name: /Drive 1 \(current\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Drive 2$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Unplugged/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ejected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Broken/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Read Only/i })).not.toBeInTheDocument();
  });

  it("calls onConfirm with selected destination drive and folder", async () => {
    const onConfirm = vi.fn();
    renderModal({
      drives: [
        { id: "d1", label: "Drive 1", state: "healthy" },
        { id: "d2", label: "Drive 2", state: "healthy" },
      ],
      initialDriveId: "d1",
      onConfirm,
    });

    const dropdownTrigger = document.querySelector('[data-slot="dropdown-trigger"]');
    expect(dropdownTrigger).toBeInTheDocument();
    fireEvent.click(dropdownTrigger);
    fireEvent.click(await screen.findByRole("option", { name: /^Drive 2$/i }));

    const startBtn = screen.getByRole("button", { name: /Start moving/i });
    fireEvent.click(startBtn);

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        driveId: "d2",
        path: "",
      }),
      expect.any(Function),
    );
  });

  it("offers a member's writable grants but not a grant on a read-only drive", async () => {
    const json = (body) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/auth/me")) return json({ id: "u1", username: "max", role: "member" });
      if (u.endsWith("/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/setup")) return json({ setup_completed: true });
      if (u.endsWith("/drives")) return json([
        { id: "ro", label: "Read-only drive", state: "readonly", mounted: true },
        { id: "rw", label: "Writable drive", state: "as_is", mounted: true },
      ]);
      if (u.endsWith("/me/access")) return json([
        { drive_id: "ro", path: "Archive", caps: "full", name: "Archive on read-only" },
        { drive_id: "rw", path: "Inbox", caps: "full", name: "Inbox" },
        { drive_id: "rw", path: "Documents", caps: "full", name: "Documents" },
      ]);
      return json([]);
    }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <FolderPickerModal
              open
              title="Copy files"
              drives={[
                { id: "ro", label: "Read-only drive", state: "readonly" },
                { id: "rw", label: "Writable drive", state: "as_is" },
              ]}
              initialDriveId="ro"
              initialPath="Archive"
              confirmLabel="Start copying"
              onClose={vi.fn()}
              onConfirm={vi.fn()}
            />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
      </ToastProvider>,
    );

    expect(await screen.findByText("Destination")).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-slot="dropdown-trigger"]'));
    expect(await screen.findByRole("option", { name: /^Inbox$/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Documents$/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Archive on read-only/i })).not.toBeInTheDocument();
  });
});
