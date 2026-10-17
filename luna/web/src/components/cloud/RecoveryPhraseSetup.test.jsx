import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";
import { derive, newEntropy, verify } from "../../lib/backupCrypto";
import { fromBase64, toBase64 } from "../../lib/cloudPhrase";

const LUNA_ID = "luna-1";
const USER_ID = "42";

function renderSetup(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RecoveryPhraseSetup lunaId={LUNA_ID} userId={USER_ID} onClose={onClose} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

/** The 12 words shown on screen, in order. */
function shownWords() {
  return within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent.trim().replace(/^\d+\.\s*/, ""));
}

/** Answers each "Word N" box with the matching word from the list. */
async function answerCheck(user, words, overrides = {}) {
  for (const input of screen.getAllByRole("textbox")) {
    const label = input.closest("label").textContent;
    const n = Number(label.match(/Word (\d+)/)[1]);
    await user.type(input, overrides[n] ?? words[n - 1]);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecoveryPhraseSetup", () => {
  it("shows 12 numbered words and never writes them to storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderSetup();

    expect(shownWords()).toHaveLength(12);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("rejects a wrong word at the confirm step without saving", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();

    await user.click(screen.getByRole("button", { name: "I wrote them down" }));
    const first = screen.getAllByRole("textbox")[0];
    await user.type(first, "definitely-not-a-word");
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));

    expect(await screen.findByText(/doesn't match. Check your list/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves with 32-byte base64 public keys and no signature for a first set-up", async () => {
    const user = userEvent.setup();
    const sent = {};
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      sent.path = String(path);
      sent.method = options.method;
      sent.body = JSON.parse(options.body);
      return new Response(JSON.stringify({ set: true, set_at: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { onClose } = renderSetup();
    const words = shownWords();

    await user.click(screen.getByRole("button", { name: "I wrote them down" }));
    await answerCheck(user, words);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent.method).toBe("PUT");
    expect(sent.path).toBe("/api/v1/cloud/phrase");
    expect(sent.body).not.toHaveProperty("signature");
    expect(fromBase64(sent.body.x25519_public)).toHaveLength(32);
    expect(fromBase64(sent.body.auth_public)).toHaveLength(32);
  });

  it("signs the save with the old phrase when replacing one", async () => {
    const user = userEvent.setup();
    const oldEntropy = newEntropy();
    const { authPublic } = derive(oldEntropy, LUNA_ID);
    const challenge = new Uint8Array(32).fill(7);
    const sent = {};
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      const url = String(path);
      if (url.endsWith("/challenge")) {
        return new Response(JSON.stringify({ challenge: toBase64(challenge) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      sent.body = JSON.parse(options.body);
      return new Response(JSON.stringify({ set: true, set_at: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { onClose } = renderSetup({ oldEntropy });
    const words = shownWords();

    await user.click(screen.getByRole("button", { name: "I wrote them down" }));
    await answerCheck(user, words);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(verify(authPublic, "phrase-check", challenge, fromBase64(sent.body.signature))).toBe(true);
  });
});
