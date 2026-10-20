import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";
import { canonical, decrypt, derive, phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { fromBase64, toBase64 } from "../../lib/cloudPhrase";

const LUNA_ID = "luna-1";
const USER_ID = "42";
const SIGNING_PUBLIC = new Uint8Array(32).map((_, i) => i + 100);

function renderSetup(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RecoveryPhraseSetup
          lunaId={LUNA_ID}
          userId={USER_ID}
          signingPublic={toBase64(SIGNING_PUBLIC)}
          onClose={onClose}
          {...props}
        />
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
  vi.restoreAllMocks();
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
    expect(fromBase64(sent.body.seal_public)).toHaveLength(1216);
    expect(fromBase64(sent.body.auth_public)).toHaveLength(32);
    const keys = derive(phraseToEntropy(words.join(" ")), LUNA_ID);
    const aad = canonical([
      ["luna_id", new TextEncoder().encode(LUNA_ID)],
      ["user_id", new TextEncoder().encode(USER_ID)],
      ["purpose", new TextEncoder().encode("signing-public")],
    ]);
    expect(decrypt(keys.selfKey, aad, fromBase64(sent.body.self_sealed))).toEqual(SIGNING_PUBLIC);
  });

  it("replaces a phrase without asking for the old one", async () => {
    const user = userEvent.setup();
    const sent = { paths: [] };
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      sent.paths.push(String(path));
      sent.body = options.body ? JSON.parse(options.body) : undefined;
      return new Response(JSON.stringify({ set: true, set_at: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { onClose } = renderSetup({ replacing: true });
    expect(screen.getByRole("heading", { name: "Set a new recovery phrase" })).toBeInTheDocument();
    const words = shownWords();

    await user.click(screen.getByRole("button", { name: "I wrote them down" }));
    await answerCheck(user, words);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent.paths).toEqual(["/api/v1/cloud/phrase"]);
    expect(sent.body).not.toHaveProperty("signature");
    expect(sent.body.self_sealed).toBeTruthy();
  });

  it("says what happens to the cloud if the phrase is lost", () => {
    renderSetup();
    expect(
      screen.getByText("If you lose it, no one can open your cloud backups for you, including us."),
    ).toBeInTheDocument();
  });

  it("prints the 12 words in a new window", async () => {
    const user = userEvent.setup();
    /** @type {any} */
    const win = { document: { write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(win);
    renderSetup();
    const words = shownWords();

    await user.click(screen.getByRole("button", { name: "Print" }));

    expect(open).toHaveBeenCalledWith("", "_blank");
    const html = win.document.write.mock.calls[0][0];
    for (const word of words) expect(html).toContain(`>${words.indexOf(word) + 1}. ${word}<`);
    expect(win.document.close).toHaveBeenCalled();
    expect(win.print).toHaveBeenCalled();
  });

  it("explains how to print when the browser blocks the print window", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    renderSetup();

    await user.click(screen.getByRole("button", { name: "Print" }));

    expect(
      await screen.findByText("Could not open the print window. Allow pop-ups for Luna, or use Download."),
    ).toBeInTheDocument();
  });

  it("downloads the 12 words as a text file", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn((/** @type {Blob} */ _blob) => "blob:phrase");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    /** @type {HTMLAnchorElement | null} */
    let clicked = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      /** @this {HTMLAnchorElement} */ function clickStub() {
        clicked = this;
      },
    );
    renderSetup();
    const words = shownWords();

    await user.click(screen.getByRole("button", { name: "Download" }));

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/plain");
    const text = await blob.text();
    expect(text).toContain(`1. ${words[0]}`);
    expect(text).toContain(`12. ${words[11]}`);
    expect(clicked?.download).toBe("luna-recovery-phrase.txt");
    expect(clicked?.href).toBe("blob:phrase");
  });
});
