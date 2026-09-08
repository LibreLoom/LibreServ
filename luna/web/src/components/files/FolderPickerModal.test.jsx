import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import FolderPickerModal from "./FolderPickerModal.jsx";

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
      </QueryClientProvider>,
    );
  }

  it("renders segmented buttons when drives <= 4", async () => {
    renderModal({
      drives: [
        { id: "d1", label: "Drive 1", state: "healthy" },
        { id: "d2", label: "Drive 2", state: "healthy" },
        { id: "d3", label: "Drive 3", state: "healthy" },
      ],
    });

    expect(await screen.findByText("Destination drive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Drive 1 \(current\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Drive 2$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Drive 3$/i })).toBeInTheDocument();
  });

  it("renders a dropdown when drives > 4 (supporting 10+ drives gracefully)", async () => {
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
    expect(screen.getByRole("button", { name: /Drive 1 \(current\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Drive 2$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unplugged/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ejected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Broken/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read Only/i })).not.toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: /Drive 2/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Drive 2/i }));

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
});
