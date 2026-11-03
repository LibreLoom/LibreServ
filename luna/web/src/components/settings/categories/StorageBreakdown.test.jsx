import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import StorageBreakdown from "./StorageBreakdown.jsx";

const STORAGE = {
  total_bytes: 8_000_000_000,
  free_bytes: 5_200_000_000,
  used_bytes: 2_800_000_000,
  items: [
    { id: "office_pack", label: "Office editor", bytes: 1_400_000_000, removable: false },
    { id: "temporary", label: "Temporary files from open documents", bytes: 1_200_000_000, removable: true },
    { id: "logs", label: "Logs", bytes: 8_000_000, removable: false },
  ],
};

/** @param {{ storage?: object, cleanup?: object, status?: number }} [opts] */
function stubFetch({ storage = STORAGE, cleanup, status = 200 } = {}) {
  return vi.fn(async (path, init) => {
    const url = String(path);
    if (url.includes("/system/storage/cleanup")) {
      return new Response(JSON.stringify(cleanup ?? { freed_bytes: 0, cleared: [] }), {
        status: init?.method === "POST" ? 200 : 405,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/system/storage")) {
      return new Response(JSON.stringify(storage), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

function renderBreakdown(fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <StorageBreakdown />
        <Toaster />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("StorageBreakdown", () => {
  it("says how much is free and what is using the disk", async () => {
    renderBreakdown(stubFetch());
    expect(await screen.findByText(/5\.2 GB free of 8\.0 GB/)).toBeInTheDocument();
    expect(screen.getByText("Office editor")).toBeInTheDocument();
    expect(screen.getByText("1.4 GB")).toBeInTheDocument();
    expect(screen.getByText("Temporary files from open documents")).toBeInTheDocument();
  });

  it("keeps the biggest row first, as lunad sends it", async () => {
    renderBreakdown(stubFetch());
    await screen.findByText("Office editor");
    const labels = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(labels[0]).toContain("Office editor");
    expect(labels[1]).toContain("Temporary files");
  });

  it("offers to clear the temporary files", async () => {
    const fetchMock = stubFetch({ cleanup: { freed_bytes: 1_200_000_000, cleared: ["temporary"] } });
    renderBreakdown(fetchMock);

    const button = await screen.findByRole("button", { name: "Free up space" });
    await userEvent.click(button);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/system/storage/cleanup"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("Freed 1.2 GB.")).toBeInTheDocument();
  });

  it("says so when there was nothing to clear", async () => {
    renderBreakdown(stubFetch({ cleanup: { freed_bytes: 0, cleared: [] } }));
    await userEvent.click(await screen.findByRole("button", { name: "Free up space" }));
    expect(await screen.findByText("Nothing to clear right now.")).toBeInTheDocument();
  });

  it("hides the button when nothing can be cleared", async () => {
    renderBreakdown(
      stubFetch({
        storage: { ...STORAGE, items: STORAGE.items.filter((item) => !item.removable) },
      }),
    );
    await screen.findByText("Office editor");
    expect(screen.queryByRole("button", { name: "Free up space" })).toBeNull();
  });

  it("says plainly when it could not read the disk", async () => {
    renderBreakdown(stubFetch({ status: 500 }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Luna couldn't look at its own storage. Try again in a moment.");
  });
});
