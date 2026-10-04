import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import ConnectSetupCodeForm from "./ConnectSetupCodeForm.jsx";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** @param {{ status?: object, onPost?: (body: any) => Response, onDelete?: () => Response }} opts */
function stub({ status = { connect_active: false }, onPost, onDelete } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/connect/status")) return json(status);
    if (u.includes("/connect/device-token") && method === "POST") return onPost ? onPost(JSON.parse(init.body)) : json({ ok: true });
    if (u.includes("/connect/device-token") && method === "DELETE") return onDelete ? onDelete() : json({ ok: true });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderForm(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <ConnectSetupCodeForm {...props} />
      </QueryClientProvider>
    </ToastProvider>,
  );
}

const calls = (fetchMock, method) =>
  fetchMock.mock.calls.filter(([, init]) => (init?.method || "GET") === method);

describe("ConnectSetupCodeForm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps Save off until the token is long enough, then sends it trimmed", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderForm();
    const save = screen.getByRole("button", { name: "Save device token" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Device token from Luna Connect"), "  ABCD-EFGH-JKMN-PQRS-TVWX  ");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(calls(fetchMock, "POST")).toHaveLength(1));
    expect(JSON.parse(calls(fetchMock, "POST")[0][1].body)).toEqual({ token: "ABCD-EFGH-JKMN-PQRS-TVWX" });
    expect(await screen.findByText("Device token saved.")).toBeInTheDocument();
    // The field is cleared so the token isn't left on screen.
    expect(screen.getByLabelText("Device token from Luna Connect")).toHaveValue("");
  });

  it("shows a rejected token as an alert with the server's words", async () => {
    stub({ onPost: () => json({ error: "That device token should look like ****-****-****-****-****." }, 400) });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Device token from Luna Connect"), "ABCDEFGHJKMNPQRSTVWX");
    await user.click(screen.getByRole("button", { name: "Save device token" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That device token should look like");
    expect(alert.className).not.toMatch(/text-error/);
    expect(screen.queryByText("Device token saved.")).toBeNull();
  });

  it("offers Remove only when a token exists, and removes it", async () => {
    const fetchMock = stub({ status: { connect_active: true } });
    const user = userEvent.setup();
    renderForm();
    const remove = await screen.findByRole("button", { name: "Remove device token" });
    await user.click(remove);
    await waitFor(() => expect(calls(fetchMock, "DELETE")).toHaveLength(1));
  });

  it("hides Remove when there is no token", async () => {
    stub({ status: { connect_active: false } });
    renderForm();
    await screen.findByText(/Paste your device token from/);
    expect(screen.queryByRole("button", { name: "Remove device token" })).toBeNull();
  });

  it("shows a stored token's problem, and still allows removing it", async () => {
    stub({ status: { connect_active: false, device_token_error: "Luna Connect didn't accept this device token." } });
    renderForm();
    expect(await screen.findByRole("alert")).toHaveTextContent("didn't accept this device token");
    expect(screen.getByRole("button", { name: "Remove device token" })).toBeInTheDocument();
  });

  it("links to Luna Connect safely", async () => {
    stub();
    renderForm();
    const link = await screen.findByRole("link", { name: "connect.luna.libreloom.org" });
    expect(link).toHaveAttribute("href", "https://connect.luna.libreloom.org");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
