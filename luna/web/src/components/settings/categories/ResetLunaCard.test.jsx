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

/** Stubs fetch with one answer per path. */
function routes(table) {
  const fetchMock = vi.fn(async (/** @type {any} */ url) => {
    const path = new URL(String(url), "http://luna.test").pathname;
    const answer = table[path];
    return answer ? answer() : json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The JSON bodies POSTed to `path`, in order. */
function posted(fetchMock, path) {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes(path) && /** @type {any} */ (init)?.method === "POST")
    .map(([, init]) => JSON.parse(/** @type {any} */ (init).body));
}

describe("ResetLunaCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps Reset disabled until a password is typed, then posts it", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { paired: false }),
      "/api/v1/system/factory-reset": () => json(401, { error: "That password is wrong. Reset was not started." }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
    const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0]).toEqual({ confirm: true, password: "hunter22", connect: "keep" });
    // A wrong password stays inside the dialog.
    expect(await within(dialog).findByText(/password is wrong/i)).toBeTruthy();
  });

  it("asks a linked Luna whether to unbind, and keeps the link when told to", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { paired: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
    let dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    dialog = await screen.findByRole("dialog", { name: "Unbinding Luna Connect" });
    expect(within(dialog).getByText(/Luna Connect website/i)).toBeTruthy();
    expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Keep linked" }));

    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("keep");
    expect(posted(fetchMock, "/api/v1/connect/unbind")).toHaveLength(0);
  });

  it("offers Retry and Skip when the unbind fails, and Skip resets with the unbind still owed", async () => {
    let unbindCalls = 0;
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { paired: true }),
      "/api/v1/connect/unbind": () => {
        unbindCalls += 1;
        return json(504, { error: "Luna Connect didn't answer, or had a problem. Check this Luna's internet connection, then try again." });
      },
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
    let dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    dialog = await screen.findByRole("dialog", { name: "Unbinding Luna Connect" });
    await user.click(within(dialog).getByRole("button", { name: "Unbind" }));

    // The error stays in the dialog, with Retry and Skip.
    expect(await within(dialog).findByText(/didn't answer/i)).toBeTruthy();
    expect(within(dialog).getByText(/Luna Connect website/i)).toBeTruthy();
    expect(posted(fetchMock, "/api/v1/connect/unbind")[0]).toEqual({ password: "hunter22" });
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(unbindCalls).toBe(2));
    expect(await within(dialog).findByRole("button", { name: "Skip" })).toBeTruthy();
    expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("pending");
  });

  it("resets as unbound once the unbind goes through", async () => {
    const fetchMock = routes({
      "/api/v1/connect/status": () => json(200, { paired: true }),
      "/api/v1/connect/unbind": () => json(200, { ok: true }),
      "/api/v1/system/factory-reset": () => json(500, { error: "Luna couldn't finish the reset. Try again." }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
    let dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    dialog = await screen.findByRole("dialog", { name: "Unbinding Luna Connect" });
    await user.click(within(dialog).getByRole("button", { name: "Unbind" }));

    await waitFor(() => expect(posted(fetchMock, "/api/v1/system/factory-reset")).toHaveLength(1));
    expect(posted(fetchMock, "/api/v1/system/factory-reset")[0].connect).toBe("unbound");
  });
});
