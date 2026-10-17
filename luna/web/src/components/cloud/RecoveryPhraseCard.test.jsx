import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RecoveryPhraseCard from "./RecoveryPhraseCard.jsx";

vi.mock("../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "42" } }),
}));

function stubStatus(status) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } })));
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecoveryPhraseCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecoveryPhraseCard", () => {
  it("explains why the phrase matters and offers Set up when not set", async () => {
    stubStatus({ set: false, set_at: null, luna_id: "luna-1" });
    renderCard();

    expect(await screen.findByText(/Cloud backups are locked with 12 words only you know/)).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("shows the date it was set with Check my words and Change when set", async () => {
    stubStatus({ set: true, set_at: 1_700_000_000, luna_id: "luna-1" });
    renderCard();

    expect(await screen.findByText(/Set on /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check my words" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("shows the API's own error sentence when status cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Luna could not read its keys." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })));
    renderCard();

    expect(await screen.findByText("Luna could not read its keys.")).toBeInTheDocument();
  });
});
