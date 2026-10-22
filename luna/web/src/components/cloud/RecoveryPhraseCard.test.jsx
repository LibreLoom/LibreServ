import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import RecoveryPhraseCard from "./RecoveryPhraseCard.jsx";
import { toBase64 } from "../../lib/cloudPhrase";
import { entropyToPhrase, newEntropy, SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";

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
        <Toaster />
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
    expect(screen.getByText(/Private items backed up with the old phrase can't be opened anymore/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));

    expect(await screen.findByRole("heading", { name: "Get a new phrase?" })).toBeInTheDocument();
    expect(screen.getByText("Private items backed up with your old phrase can't be opened anymore.")).toBeInTheDocument();
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

// ── Replacing and checking the phrase ────────────────────────────────────────

const SET_STATUS = {
  set: true,
  set_at: 1_700_000_000,
  last_checked_at: 1_700_500_000,
  check_due: false,
  luna_id: "luna-1",
  signing_public: toBase64(SIGNING_PUBLIC),
  old_phrase_copies: { count: 0, removed_at: 0 },
};
const CHALLENGE = toBase64(new Uint8Array(32).map((_, i) => 100 + i));

/**
 * Routes the phrase endpoints. Each reply is [status, body] or a function of the call.
 * `status` and `put` may be functions of the calls so far (for state that changes after a save).
 */
function routePhraseApi(/** @type {any} */ options = {}) {
  const { status = SET_STATUS, check = [200, { ok: true }], put = [200, { set: true, set_at: 1 }] } = options;
  const calls = [];
  const fetchMock = vi.fn(async (path, options = {}) => {
    const method = options.method ?? "GET";
    const key = `${method} ${String(path)}`;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ key, body });
    let reply;
    if (key === "GET /api/v1/cloud/phrase") reply = typeof status === "function" ? status(calls) : [200, status];
    else if (key === "POST /api/v1/cloud/phrase/challenge") reply = [200, { challenge: CHALLENGE }];
    else if (key === "POST /api/v1/cloud/phrase/check") reply = check;
    else if (key === "PUT /api/v1/cloud/phrase") reply = typeof put === "function" ? put(calls) : put;
    else reply = [404, { error: "not in this test" }];
    const [code, payload] = reply;
    return jsonResponse(payload, code);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, puts: () => calls.filter((c) => c.key === "PUT /api/v1/cloud/phrase").map((c) => c.body) };
}

/** Pastes a phrase into the check boxes and continues. */
async function typePhraseAndContinue(user, phrase, label = "Continue") {
  await user.click(screen.getByLabelText("Word 1"));
  await user.paste(phrase);
  await user.click(screen.getByRole("button", { name: label }));
}

/** Reads the new phrase on screen, then types the three asked words to confirm it. Returns the phrase. */
async function confirmShownPhrase(user) {
  const words = screen.getAllByRole("listitem").map((li) => li.textContent.replace(/^\d+\./, ""));
  await user.click(screen.getByRole("button", { name: "I wrote them down" }));
  for (const label of screen.getAllByText(/^Word \d+$/)) {
    const n = Number(label.textContent.split(" ")[1]);
    await user.type(label.closest("label").querySelector("input"), words[n - 1]);
  }
  await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
  return words.join(" ");
}

describe("RecoveryPhraseCard, change phrase", () => {
  it("refuses a wrong current phrase inline and never sends a save", async () => {
    const user = userEvent.setup();
    const api = routePhraseApi({ check: [403, { error: "no" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));

    expect(await screen.findByText(/not the recovery phrase set up on this Luna/)).toBeInTheDocument();
    expect(screen.queryByText("Could someone else have your phrase?")).toBeNull();
    expect(api.puts()).toHaveLength(0);
    expect(screen.queryByText("Recovery phrase changed.")).toBeNull();
  });

  it("shows the lockout message from a 429 on the check and does not retry", async () => {
    const user = userEvent.setup();
    const api = routePhraseApi({ check: [429, { error: "slow down" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));

    expect(await screen.findByText("Too many wrong tries. Wait a few minutes, then try again.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === "POST /api/v1/cloud/phrase/check")).toHaveLength(1);
  });

  it("saves with an old-phrase signature and exposed false, then toasts", async () => {
    const user = userEvent.setup();
    const api = routePhraseApi();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));
    await user.click(await screen.findByText("No, it's only mine"));
    await confirmShownPhrase(user);

    expect(await screen.findByText("Recovery phrase changed.")).toBeInTheDocument();
    const [put] = api.puts();
    expect(put.proof).toBe("old_signature");
    expect(put.exposed).toBe(false);
    expect(put.signature).toEqual(expect.any(String));
    expect(put).not.toHaveProperty("password");
    expect(api.calls.map((c) => c.key)).toContain("POST /api/v1/cloud/phrase/challenge");
  });

  it("forwards exposed true when the answer is Someone may have it", async () => {
    const user = userEvent.setup();
    const api = routePhraseApi();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));
    await user.click(await screen.findByText("Someone may have it"));
    await confirmShownPhrase(user);

    expect(await screen.findByText("Recovery phrase changed.")).toBeInTheDocument();
    expect(api.puts()[0].exposed).toBe(true);
  });

  it("keeps the dialog open with the refusal inline and shows no toast when the save is refused", async () => {
    const user = userEvent.setup();
    routePhraseApi({ put: [403, { error: "no" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));
    await user.click(await screen.findByText("No, it's only mine"));
    await confirmShownPhrase(user);

    expect(await screen.findByText(/Luna did not accept your old phrase/)).toBeInTheDocument();
    expect(screen.queryByText("Recovery phrase changed.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save recovery phrase" })).toBeInTheDocument();
  });

  it("shows the lockout message when the save is locked out, with no toast", async () => {
    const user = userEvent.setup();
    routePhraseApi({ put: [429, { error: "slow down" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));
    await user.click(await screen.findByText("No, it's only mine"));
    await confirmShownPhrase(user);

    expect(await screen.findByText("Too many wrong tries. Wait a few minutes, then try again.")).toBeInTheDocument();
    expect(screen.queryByText("Recovery phrase changed.")).toBeNull();
  });
});

describe("RecoveryPhraseCard, get a new phrase (lost)", () => {
  it("sends the Luna password as the proof, with exposed false, then shows the old-phrase copies row", async () => {
    const user = userEvent.setup();
    let copies = { count: 0, removed_at: 0 };
    const api = routePhraseApi({
      status: () => [200, { ...SET_STATUS, old_phrase_copies: copies }],
      put: () => {
        copies = { count: 2, removed_at: 1_700_900_000 };
        return [200, { set: true, set_at: 1 }];
      },
    });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Lost your recovery phrase?" }));
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByText("No, it's just lost"));
    await user.type(screen.getByLabelText("Your Luna password"), "a long password");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await confirmShownPhrase(user);

    expect(await screen.findByText("New recovery phrase saved.")).toBeInTheDocument();
    const [put] = api.puts();
    expect(put.proof).toBe("password");
    expect(put.password).toBe("a long password");
    expect(put.exposed).toBe(false);
    expect(put).not.toHaveProperty("signature");
    expect(await screen.findByText(/^Backups made with your old phrase · removed on /)).toBeInTheDocument();
  });

  it("sends exposed true when the answer is Someone may have it", async () => {
    const user = userEvent.setup();
    const api = routePhraseApi();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Lost your recovery phrase?" }));
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByText("Someone may have it"));
    await user.type(screen.getByLabelText("Your Luna password"), "pw");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await confirmShownPhrase(user);

    expect(await screen.findByText("New recovery phrase saved.")).toBeInTheDocument();
    expect(api.puts()[0].exposed).toBe(true);
  });

  it("refuses a wrong password inline, with no toast", async () => {
    const user = userEvent.setup();
    routePhraseApi({ put: [403, { error: "no" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Lost your recovery phrase?" }));
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByText("No, it's just lost"));
    await user.type(screen.getByLabelText("Your Luna password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await confirmShownPhrase(user);

    expect(await screen.findByText("That is not your Luna password. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("New recovery phrase saved.")).toBeNull();
  });

  it("shows the lockout message when the password is locked out", async () => {
    const user = userEvent.setup();
    routePhraseApi({ put: [429, { error: "slow down" }] });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Lost your recovery phrase?" }));
    await user.click(screen.getByRole("button", { name: "Get a new phrase" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByText("No, it's just lost"));
    await user.type(screen.getByLabelText("Your Luna password"), "pw");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await confirmShownPhrase(user);

    expect(await screen.findByText("Too many wrong tries. Wait a few minutes, then try again.")).toBeInTheDocument();
  });
});

describe("RecoveryPhraseCard, check my phrase", () => {
  it("refuses wrong words in the check and keeps the reminder", async () => {
    const user = userEvent.setup();
    routePhraseApi({ check: [403, { error: "no" }], status: { ...SET_STATUS, check_due: true } });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Check my phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)), "Check");

    expect(await screen.findByText(/not the recovery phrase set up on this Luna/)).toBeInTheDocument();
    expect(screen.getByText("Check due")).toBeInTheDocument();
  });
});

describe("RecoveryPhraseCard, resealing", () => {
  it("says backups are updating while status reports resealing", async () => {
    routePhraseApi({ status: { ...SET_STATUS, resealing: true } });
    renderCard();
    expect(await screen.findByText("Updating your cloud backups to the new phrase…")).toBeInTheDocument();
  });

  it("does not show the line when resealing is false", async () => {
    routePhraseApi({ status: { ...SET_STATUS, resealing: false } });
    renderCard();
    await screen.findByText("Ready");
    expect(screen.queryByText("Updating your cloud backups to the new phrase…")).toBeNull();
  });

  it("polls status while resealing and stops once it is false", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resealing = true;
      const api = routePhraseApi({ status: () => [200, { ...SET_STATUS, resealing }] });
      renderCard();
      expect(await screen.findByText("Updating your cloud backups to the new phrase…")).toBeInTheDocument();

      resealing = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      await waitFor(() => expect(screen.queryByText("Updating your cloud backups to the new phrase…")).toBeNull());

      const gets = () => api.calls.filter((c) => c.key === "GET /api/v1/cloud/phrase").length;
      const settled = gets();
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(gets()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RecoveryPhraseCard, signing key stays in memory", () => {
  it("never writes the phrase or the keys to browser storage during a change", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    routePhraseApi();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Change phrase" }));
    await typePhraseAndContinue(user, entropyToPhrase(newEntropy(12)));
    await user.click(await screen.findByText("No, it's only mine"));
    await confirmShownPhrase(user);
    await screen.findByText("Recovery phrase changed.");
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
