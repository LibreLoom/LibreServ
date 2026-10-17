import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import RecoveryPhraseCard from "./RecoveryPhraseCard.jsx";
import { toBase64 } from "../../lib/cloudPhrase";

const SIGNING_PUBLIC = new Uint8Array(32).map((_, i) => i + 7);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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
      <ToastProvider>
        <RecoveryPhraseCard />
      </ToastProvider>
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

  it("creates Luna's identity first when a fresh Luna sets up its phrase", async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      calls.push([String(path), options.method ?? "GET"]);
      if (String(path) === "/api/v1/cloud/identity") {
        return jsonResponse({ luna_id: "luna-new", signing_public: toBase64(SIGNING_PUBLIC) });
      }
      return jsonResponse({ set: false, set_at: null, luna_id: null });
    }));
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Set up" }));

    expect(await screen.findByRole("heading", { name: "Set up your recovery phrase" })).toBeInTheDocument();
    expect(calls).toContainEqual(["/api/v1/cloud/identity", "POST"]);
  });

  it("offers Get a new phrase with a warning and no request for the old words", async () => {
    const user = userEvent.setup();
    stubStatus({ set: true, set_at: 1_700_000_000, luna_id: "luna-1", signing_public: toBase64(SIGNING_PUBLIC) });
    renderCard();

    expect(await screen.findByText(/Your old phrase stops working for you/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));

    expect(await screen.findByRole("heading", { name: "Set a new recovery phrase" })).toBeInTheDocument();
    expect(screen.queryByText("Enter your current 12 words first. Then you can set new ones.")).toBeNull();
  });

  it("shows an error and stays put when Luna cannot create its identity", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (path) => {
      if (String(path) === "/api/v1/cloud/identity") return jsonResponse({ error: "Luna could not make its keys." }, 500);
      return jsonResponse({ set: false, set_at: null, luna_id: null });
    }));
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Set up" }));

    expect(await screen.findByText("Luna could not make its keys.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Set up your recovery phrase" })).toBeNull());
  });
});
