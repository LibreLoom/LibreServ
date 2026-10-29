import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { toBase64 } from "../../lib/cloudPhrase";
import PhraseStep from "./PhraseStep.jsx";

const auth = vi.hoisted(() => ({ value: /** @type {any} */ ({ user: { id: 7 } }) }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => auth.value,
  useOptionalAuth: () => auth.value,
}));

const SIGNING_PUBLIC = toBase64(new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 5) % 256));

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderStep(props = {}) {
  const onSaved = props.onSaved || vi.fn(async () => {});
  render(
    <div className="surface-secondary">
      <PhraseStep onSaved={onSaved} {...props} />
    </div>,
  );
  return { onSaved };
}

beforeEach(() => {
  auth.value = { user: { id: 7 } };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhraseStep", () => {
  it("says it is making the phrase while Luna makes its keys", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderStep();
    expect(screen.getByText("Making your recovery phrase…")).toBeInTheDocument();
  });

  it("shows Luna's message and 'Try again' when the keys can't be made, then recovers", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return reply({ error: "Luna could not make its keys." }, 409);
      return reply({ luna_id: "luna-1", signing_public: SIGNING_PUBLIC });
    }));
    renderStep();
    expect(await screen.findByText("Luna could not make its keys.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Write down your recovery phrase" })).toBeInTheDocument();
  });

  it("saves the phrase with its length, then moves on", async () => {
    const user = userEvent.setup();
    const sent = {};
    vi.stubGlobal("fetch", vi.fn(async (path, options = {}) => {
      if (String(path).endsWith("/cloud/identity")) return reply({ luna_id: "luna-1", signing_public: SIGNING_PUBLIC });
      sent.method = options.method;
      sent.body = JSON.parse(options.body);
      return reply({ set: true, set_at: 1 });
    }));
    const { onSaved } = renderStep();
    await screen.findByRole("heading", { name: "Write down your recovery phrase" });
    const words = within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent.trim().replace(/^\d+\.\s*/, ""));
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    for (const input of screen.getAllByRole("textbox")) {
      const n = Number(input.getAttribute("aria-label").replace("Word ", ""));
      await user.type(input, words[n - 1]);
    }
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent.method).toBe("PUT");
    expect(sent.body.words).toBe(12);
    expect(sent.body.self_sealed).toBeTruthy();
  });
});
