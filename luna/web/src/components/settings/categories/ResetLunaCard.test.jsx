import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import ResetLunaCard from "./ResetLunaCard.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <ResetLunaCard />
      </QueryClientProvider>
    </ToastProvider>,
  );
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function routes(table) {
  const fetchMock = vi.fn(async (/** @type {any} */ url) => {
    const path = new URL(String(url), "http://luna.test").pathname;
    const answer = table[path];
    return answer ? answer() : json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function posted(fetchMock, path) {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes(path) && /** @type {any} */ (init)?.method === "POST")
    .map(([, init]) => JSON.parse(/** @type {any} */ (init).body));
}

async function openConnectStep(user) {
  await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
  let dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
  await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
  const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  dialog = await screen.findByRole("dialog", { name: "Keep or disconnect Luna Connect?" });
  return dialog;
}

describe("ResetLunaCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("always asks Keep Connect or Disconnect, even when no Luna is paired", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state: "unbound", paired: false, connect_active: false }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    expect(within(dialog).getByRole("button", { name: "Keep Connect" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Keep Connect" }));
    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0]).toEqual({
      confirm: true,
      password: "hunter22",
      connect: "keep",
    });
    expect(posted(fetchMock, "/api/v1/connect/unbind")).toHaveLength(0);
  });

  it("keeps a wrong-password error inside the dialog", async () => {
    routes({
      "/api/v1/connect/status": () => json(200, { state: "unbound", paired: false }),
      "/api/v1/system/factory-reset": () => json(401, { error: "That password is wrong. Reset was not started." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Keep Connect" }));
    expect(await screen.findByText(/password is wrong/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Reset this Luna?" })).toBeInTheDocument();
  });

  it("offers Retry and Reset and keep trying when Disconnect fails", async () => {
    let disconnectCalls = 0;
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state: "bound", paired: true, connect_active: true }),
      "/api/v1/connect/unbind": () => {
        disconnectCalls += 1;
        return json(504, { error: "Luna Connect didn't answer, or had a problem. Check this Luna's internet connection, then try again." });
      },
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByText(/didn't answer/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Remote access and pairing stay off/)).toBeInTheDocument();
    expect(posted(fetchMock, "/api/v1/connect/unbind")[0]).toEqual({ password: "hunter22" });

    await user.click(within(dialog).getByRole("button", { name: "Try disconnect again" }));
    await waitFor(() => expect(disconnectCalls).toBe(2));
    expect(await within(dialog).findByRole("button", { name: "Reset and keep trying" })).toBeInTheDocument();
    expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Reset and keep trying" }));
    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("disconnect");
  });

  it("resets as disconnected once Luna confirms the revocation", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state: "bound", paired: true, connect_active: true }),
      "/api/v1/connect/unbind": () => json(200, { ok: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("disconnect");
  });

  it.each(["pairing", "revoked"])("disconnects %s ownership before resetting", async (state) => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state, paired: false, connect_active: false }),
      "/api/v1/connect/unbind": () => json(200, { ok: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(posted(fetchMock, "/api/v1/connect/unbind")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/connect/unbind")[0]).toEqual({ password: "hunter22" });
    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("disconnect");
  });

  it("requires password step-up before clearing revoked ownership", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state: "revoked", paired: false, connect_active: false }),
      "/api/v1/connect/unbind": () => json(401, { error: "That password is wrong. Luna Connect was not disconnected." }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByText(/password is wrong/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Reset this Luna?" })).toBeInTheDocument();
    expect(posted(fetchMock, "/api/v1/connect/unbind")).toEqual([{ password: "hunter22" }]);
    expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(0);
  });

  it("does not offer an ordinary pending reset after a revoked disconnect fails", async () => {
    routes({
      "/api/v1/connect/status": () => json(200, { state: "revoked", paired: false, connect_active: false }),
      "/api/v1/connect/unbind": () => json(504, { error: "Luna Connect didn't answer, or had a problem." }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    expect(await within(dialog).findByText(/couldn't clear this Luna/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Remote access and pairing stay off/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Reset and keep trying" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Try disconnect again" })).toBeInTheDocument();
  });

  it("keeps revoked ahead of a stale pending marker", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { state: "revoked", paired: false, unbind_pending: true }),
      "/api/v1/connect/unbind": () => json(200, { ok: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    expect(within(dialog).getByRole("button", { name: "Keep Connect" })).toBeEnabled();
    expect(within(dialog).queryByText(/previous disconnect finishes/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(posted(fetchMock, "/api/v1/connect/unbind")).toHaveLength(1));
  });

  it("explains an already pending disconnect", async () => {
    routes({
      "/api/v1/connect/status": () => json(200, { state: "bound", paired: true, connect_active: false, unbind_pending: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    const dialog = await openConnectStep(user);
    expect(within(dialog).getByText(/previous disconnect finishes/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Keep Connect" })).toBeDisabled();
  });
});
