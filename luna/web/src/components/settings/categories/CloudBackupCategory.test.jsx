import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

function stubStatus(status) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } })));
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CloudBackupCategory />
    </QueryClientProvider>,
  );
}

describe("CloudBackupCategory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains how to get started before a card is added", async () => {
    stubStatus({ backup_unlocked: false });
    renderCard();
    expect(await screen.findByText(/Add a card at connect\.luna\.libreloom\.org/)).toBeInTheDocument();
    expect(screen.queryByText(/costs \$8 per terabyte/)).toBeNull();
  });

  it("states what backup does and costs once it is unlocked", async () => {
    stubStatus({ backup_unlocked: true });
    renderCard();
    expect(await screen.findByText(/costs \$8 per terabyte each month/)).toBeInTheDocument();
    expect(screen.getByText(/open it and tap Protect, then use In the cloud/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
    expect(screen.queryByText(/Last full copy/)).toBeNull();
  });

  it("says when cloud backup has stopped finishing", async () => {
    stubStatus({
      backup_unlocked: true,
      backup_status: { state: "stale", last_ok_at: 0, last_error: "" },
    });
    renderCard();
    expect(await screen.findByText(/Cloud backup hasn't finished in over a day/)).toBeInTheDocument();
    expect(screen.getByText("Last full copy: never")).toBeInTheDocument();
  });
});
