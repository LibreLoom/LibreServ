import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { toBase64 } from "../../lib/cloudPhrase";
import PhraseGate from "./PhraseGate.jsx";

const auth = vi.hoisted(() => ({ value: /** @type {any} */ ({}) }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => auth.value,
  useOptionalAuth: () => auth.value,
}));

const SIGNING_PUBLIC = toBase64(new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 5) % 256));
const logout = vi.fn();
const refresh = vi.fn();

function renderGate(user) {
  auth.value = { user, refresh, logout };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PhraseGate>
          <p>The app</p>
        </PhraseGate>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  logout.mockClear();
  refresh.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ luna_id: "luna-1", signing_public: SIGNING_PUBLIC }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhraseGate", () => {
  it("replaces the app with the phrase screen when the account has no phrase", async () => {
    renderGate({ id: 1, role: "member", phrase_set: false });
    expect(screen.getByRole("heading", { name: "Set up your recovery phrase" })).toBeInTheDocument();
    expect(
      screen.getByText("Every account on this Luna has its own recovery phrase. It locks your cloud backups so only you can open them."),
    ).toBeInTheDocument();
    expect(screen.queryByText("The app")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "I wrote it down" })).toBeInTheDocument();
  });

  it("lets the person sign out from the gate", async () => {
    const user = userEvent.setup();
    renderGate({ id: 1, role: "member", phrase_set: false });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalled();
  });

  it("shows the app when the account has a phrase", () => {
    renderGate({ id: 1, phrase_set: true });
    expect(screen.getByText("The app")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Set up your recovery phrase" })).not.toBeInTheDocument();
  });

  it("shows the app when Luna doesn't say (phrase_set missing), and re-reads the account once", () => {
    renderGate({ id: 1 });
    expect(screen.getByText("The app")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("doesn't re-read the account when it already says", () => {
    renderGate({ id: 1, phrase_set: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the app while no one is signed in", () => {
    renderGate(null);
    expect(screen.getByText("The app")).toBeInTheDocument();
  });
});
