import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import PropertiesSheet from "./PropertiesSheet.jsx";

function renderSheet(stat) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(stat), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PropertiesSheet driveId="d1" driveLabel="Photos" path="Taxes" onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

describe("PropertiesSheet private", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says an item is private", async () => {
    renderSheet({ name: "Taxes", kind: "file", size: 10, modified: 1, private: true, writable: true });
    expect(await screen.findByText("Private")).toBeInTheDocument();
    expect(screen.getByLabelText("Private")).toBeInTheDocument();
  });

  it("does not mention private for an ordinary item", async () => {
    renderSheet({ name: "Taxes", kind: "file", size: 10, modified: 1, private: false, writable: true });
    expect(await screen.findByText("View and change")).toBeInTheDocument();
    expect(screen.queryByLabelText("Private")).toBeNull();
  });
});
