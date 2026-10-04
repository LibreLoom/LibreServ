import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import UpdateSourceCard from "./UpdateSourceCard.jsx";

const DEFAULTS = { api_base: "https://gt.example.net/api/v1", owner: "LibreLoom", repo: "LibreServ", keys: ["RWDEFAULTKEY"] };
const SOURCE = { ...DEFAULTS, defaults: DEFAULTS, default_keys: true, keys: [], effective_keys: ["RWDEFAULTKEY"] };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** @param {{ source?: any, onPut?: (body: any) => Response, onKeys?: (body: any) => Response }} [opts] */
function stub({ source = SOURCE, onPut, onKeys } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.endsWith("/updates/source/keys") && method === "POST") return onKeys ? onKeys(JSON.parse(init.body)) : json({ keys: ["RWFETCHED"] });
    if (u.endsWith("/updates/source") && method === "PUT") return onPut ? onPut(JSON.parse(init.body)) : json({ ...source, ...JSON.parse(init.body) });
    if (u.endsWith("/updates/source")) return json(source);
    if (u.includes("/connect/status")) return json({ connect_active: false });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <UpdateSourceCard />
      </QueryClientProvider>
    </ToastProvider>,
  );
}

async function openEditor(user) {
  await user.click(await screen.findByRole("button", { name: /Update source/ }));
  await user.click(await screen.findByRole("button", { name: "Edit update source" }));
  return screen.findByRole("dialog", { name: "Update source" });
}

describe("UpdateSourceCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says whether updates come from the default or a custom source", async () => {
    stub();
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Update source/ }));
    expect(await screen.findByText("Default source")).toBeInTheDocument();
    expect(screen.getByText("LibreLoom/LibreServ")).toBeInTheDocument();
  });

  it("flags a custom source", async () => {
    stub({ source: { ...SOURCE, owner: "someone-else" } });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Update source/ }));
    expect(await screen.findByText("Custom source")).toBeInTheDocument();
  });

  it("explains each field problem in plain words before saving", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);

    const base = dialog.querySelector("#us-base-url");
    await user.clear(base);
    await user.type(base, "ftp://nope");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("The API address must start with http:// or https://.")).toBeInTheDocument();

    await user.clear(base);
    await user.type(base, "https://gt.example.net/api/v1");
    await user.clear(within(dialog).getByLabelText("Owner"));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/Both the owner and the repo need a value/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Owner"), "LibreLoom");
    const keys = dialog.querySelector("#us-keys");
    await user.clear(keys);
    await user.type(keys, "not a key");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/not a valid minisign public key/)).toBeInTheDocument();

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("saves the edited source, sending no keys when the built-in one is kept", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    const owner = within(dialog).getByLabelText("Owner");
    await user.clear(owner);
    await user.type(owner, "friends");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(true));
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(put[1].body)).toEqual({
      api_base: DEFAULTS.api_base,
      owner: "friends",
      repo: "LibreServ",
      keys: [],
    });
  });

  it("sends a different signer's key when one is entered", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    const keys = dialog.querySelector("#us-keys");
    await user.clear(keys);
    await user.type(keys, "RWOTHERSIGNER");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(true));
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(put[1].body).keys).toEqual(["RWOTHERSIGNER"]);
  });

  it("fetches signing keys from the project page and says so when that fails", async () => {
    let fail = false;
    stub({ onKeys: () => (fail ? json({ error: "bad" }, 502) : json({ keys: ["RWFETCHED"] })) });
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    await user.click(within(dialog).getByRole("button", { name: "Fetch from repo" }));
    await waitFor(() => expect(dialog.querySelector("#us-keys")).toHaveValue("RWFETCHED"));

    fail = true;
    await user.click(within(dialog).getByRole("button", { name: "Fetch from repo" }));
    expect(await within(dialog).findByText(/couldn't get signing keys from that project page/)).toBeInTheDocument();
  });

  it("keeps Save off until something changes, and Use defaults restores the shipped values", async () => {
    stub({ source: { ...SOURCE, owner: "someone-else" } });
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Use defaults" }));
    expect(within(dialog).getByLabelText("Owner")).toHaveValue("LibreLoom");
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
