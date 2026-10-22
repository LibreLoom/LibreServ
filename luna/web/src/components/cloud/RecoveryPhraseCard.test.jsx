import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import RecoveryPhraseCard from "./RecoveryPhraseCard.jsx";
import { toBase64 } from "../../lib/cloudPhrase";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";

const SIGNING_PUBLIC = new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 7) % 256);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let mockRole = "admin";
vi.mock("../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "42", role: mockRole } }),
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
  mockRole = "admin";
  vi.unstubAllGlobals();
});

describe("RecoveryPhraseCard", () => {
  it("shows a loading line first", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderCard();
    expect(screen.getByText("Checking your recovery phrase…")).toBeInTheDocument();
  });

  it("shows Not set up with Set up when no phrase exists", async () => {
    stubStatus({ set: false, set_at: null, luna_id: "luna-1", admin_has_phrase: true });
    renderCard();

    expect(await screen.findByText("Cloud backups of your files can start once you set one up.")).toBeInTheDocument();
    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change phrase" })).toBeNull();
    expect(screen.queryByText(/Shared backups also wait/)).toBeNull();
  });

  it("tells a Member when no Admin has a phrase yet", async () => {
    mockRole = "member";
    stubStatus({ set: false, set_at: null, luna_id: "luna-1", admin_has_phrase: false });
    renderCard();
    expect(await screen.findByText("Shared backups also wait for an Admin to set up theirs.")).toBeInTheDocument();
  });

  it("does not add the Admin line for a Member when an Admin has a phrase", async () => {
    mockRole = "member";
    stubStatus({ set: false, set_at: null, luna_id: "luna-1", admin_has_phrase: true });
    renderCard();
    await screen.findByText("Not set up");
    expect(screen.queryByText(/Shared backups also wait/)).toBeNull();
  });

  it("does not add the Admin line for an Admin", async () => {
    stubStatus({ set: false, set_at: null, luna_id: "luna-1", admin_has_phrase: false });
    renderCard();
    await screen.findByText("Not set up");
    expect(screen.queryByText(/Shared backups also wait/)).toBeNull();
  });

  it("shows Ready, the dates, and both buttons when set", async () => {
    stubStatus({ set: true, set_at: 1_700_000_000, last_checked_at: 1_700_500_000, check_due: false, luna_id: "luna-1" });
    renderCard();

    expect(await screen.findByText(/^Set up on .+ · Last checked /)).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check my phrase" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change phrase" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("says Not checked yet when the phrase was never checked", async () => {
    stubStatus({ set: true, set_at: 1_700_000_000, last_checked_at: 0, luna_id: "luna-1" });
    renderCard();
    expect(await screen.findByText(/· Not checked yet$/)).toBeInTheDocument();
  });

  it("shows Check due and makes Check my phrase the main button", async () => {
    stubStatus({ set: true, set_at: 1_700_000_000, last_checked_at: 0, check_due: true, luna_id: "luna-1" });
    renderCard();

    expect(await screen.findByText("Check due")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).toBeNull();
    const check = screen.getByRole("button", { name: "Check my phrase" });
    const change = screen.getByRole("button", { name: "Change phrase" });
    expect(check.className).not.toBe(change.className);
  });

  it("shows a plain line when status cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Luna could not read its keys." }, 500)));
    renderCard();
    expect(await screen.findByText("Could not load your recovery phrase. Try again later.")).toBeInTheDocument();
  });

  it("shows the old-phrase row and deletes after confirming", async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      calls.push([String(path), options.method ?? "GET"]);
      return jsonResponse({
        set: true, set_at: 1_700_000_000, luna_id: "luna-1",
        old_phrase_copies: { count: 2, removed_at: 1_700_900_000 },
      });
    }));
    renderCard();

    expect(await screen.findByText(/^Backups made with your old phrase · removed on /)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete now" }));
    expect(await screen.findByText(/Deleting them removes them from the cloud for good/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Delete now" }).at(-1));
    await waitFor(() => expect(calls).toContainEqual(["/api/v1/private-backups/old-copies", "DELETE"]));
  });

  it("keeps the confirm open and shows the error when deleting old backups fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      if (options.method === "DELETE") return jsonResponse({ error: "Connect is not reachable." }, 502);
      return jsonResponse({
        set: true, set_at: 1_700_000_000, luna_id: "luna-1",
        old_phrase_copies: { count: 1, removed_at: 1_700_900_000 },
      });
    }));
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Delete now" }));
    await user.click(screen.getAllByRole("button", { name: "Delete now" }).at(-1));
    expect(await screen.findByText("Connect is not reachable.")).toBeInTheDocument();
  });

  it("hides the old-phrase row when there are no old copies", async () => {
    stubStatus({ set: true, set_at: 1_700_000_000, luna_id: "luna-1", old_phrase_copies: { count: 0, removed_at: 0 } });
    renderCard();
    await screen.findByText("Ready");
    expect(screen.queryByText(/Backups made with your old phrase/)).toBeNull();
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

  it("offers Get a new phrase under Lost your recovery phrase? with a warning", async () => {
    const user = userEvent.setup();
    stubStatus({ set: true, set_at: 1_700_000_000, luna_id: "luna-1", signing_public: toBase64(SIGNING_PUBLIC) });
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Lost your recovery phrase?" }));
    expect(screen.getByText(/Your old phrase stops working for you/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));

    expect(await screen.findByRole("heading", { name: "Set a new recovery phrase" })).toBeInTheDocument();
    expect(screen.queryByText("Enter your current recovery phrase first. Then you can set a new one.")).toBeNull();
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
