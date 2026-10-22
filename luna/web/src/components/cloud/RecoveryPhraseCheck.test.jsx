import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import { derive, entropyToPhrase, newEntropy, verify } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { fromBase64, toBase64 } from "../../lib/cloudPhrase";

const LUNA_ID = "luna-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecoveryPhraseCheck", () => {
  it("uses phrase wording for its title, intro and field label", () => {
    render(<RecoveryPhraseCheck lunaId={LUNA_ID} onClose={() => {}} />);
    expect(screen.getByText("Check my phrase")).toBeInTheDocument();
    expect(screen.getByText("Type your recovery phrase in order, with a space between each one.")).toBeInTheDocument();
  });

  it("shows a length message and does not contact Luna when the phrase is too short", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RecoveryPhraseCheck lunaId={LUNA_ID} onClose={() => {}} />);
    await user.type(screen.getByRole("textbox"), "one two three");
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/needs 12 or 24/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs a fresh challenge with the words and reports a match", async () => {
    const user = userEvent.setup();
    const entropy = newEntropy();
    const { authPublic } = derive(entropy, LUNA_ID);
    const challenge = new Uint8Array(32).fill(9);
    const posted = [];
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      const url = String(path);
      if (url.endsWith("/challenge")) {
        return new Response(JSON.stringify({ challenge: toBase64(challenge) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      posted.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<RecoveryPhraseCheck lunaId={LUNA_ID} onClose={() => {}} />);
    await user.type(screen.getByRole("textbox"), entropyToPhrase(entropy));
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText("Your phrase matches your recovery phrase.")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/v1/cloud/phrase/check");
    expect(verify(authPublic, "phrase-check", challenge, fromBase64(posted[0].body.signature))).toBe(true);
  });

  it("shows the API's error sentence inline when the words do not match", async () => {
    const user = userEvent.setup();
    const entropy = newEntropy();
    vi.stubGlobal("fetch", vi.fn(async (path) => {
      if (String(path).endsWith("/challenge")) {
        return new Response(JSON.stringify({ challenge: toBase64(new Uint8Array(32)) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Those words don't match the recovery phrase set for your account." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<RecoveryPhraseCheck lunaId={LUNA_ID} onClose={() => {}} />);
    await user.type(screen.getByRole("textbox"), entropyToPhrase(entropy));
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText("Those words don't match the recovery phrase set for your account.")).toBeInTheDocument();
  });

  it("hands verified entropy to onVerified for Change, instead of showing a result", async () => {
    const user = userEvent.setup();
    const entropy = newEntropy();
    vi.stubGlobal("fetch", vi.fn(async (path) => {
      const body = String(path).endsWith("/challenge") ? { challenge: toBase64(new Uint8Array(32)) } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const onVerified = vi.fn();

    render(<RecoveryPhraseCheck lunaId={LUNA_ID} onClose={() => {}} onVerified={onVerified} />);
    await user.type(screen.getByRole("textbox"), entropyToPhrase(entropy));
    await user.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(onVerified.mock.calls[0][0]).toEqual(entropy);
  });
});
