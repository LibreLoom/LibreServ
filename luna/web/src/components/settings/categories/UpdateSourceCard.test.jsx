import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import UpdateSourceCard from "./UpdateSourceCard.jsx";

const DEFAULTS = {
  feed_url: "https://feeds.example.net/feeds",
  channel: "stable",
  keys: ["RWDEFAULTKEY"],
};
const SOURCE = {
  ...DEFAULTS,
  defaults: DEFAULTS,
  default_keys: true,
  keys: [],
  effective_keys: ["RWDEFAULTKEY"],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** @param {{ source?: any, onPut?: (body: any) => Response }} [opts] */
function stub({ source = SOURCE, onPut } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.endsWith("/updates/source") && method === "PUT") {
      return onPut ? onPut(JSON.parse(init.body)) : json({ ...source, ...JSON.parse(init.body) });
    }
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

async function openAdvanced(user) {
  await user.click(await screen.findByRole("button", { name: /^Update source$/ }));
  await user.click(await screen.findByRole("button", { name: /Feed address and signing keys/ }));
}

async function openEditor(user) {
  await openAdvanced(user);
  await user.click(await screen.findByRole("button", { name: "Edit update source" }));
  return screen.findByRole("dialog", { name: "Update source" });
}

const puts = (fetchMock) => fetchMock.mock.calls.filter(([, i]) => i?.method === "PUT");

describe("UpdateSourceCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says whether updates come from the default or a custom source", async () => {
    stub();
    const user = userEvent.setup();
    renderCard();
    await openAdvanced(user);
    expect(await screen.findByText("Default source")).toBeInTheDocument();
    expect(screen.getByText("https://feeds.example.net/feeds")).toBeInTheDocument();
  });

  it("flags a custom feed address", async () => {
    stub({ source: { ...SOURCE, feed_url: "https://staging.example.net/feeds" } });
    const user = userEvent.setup();
    renderCard();
    await openAdvanced(user);
    expect(await screen.findByText("Custom source")).toBeInTheDocument();
  });

  it("offers Stable and Beta with the current channel selected", async () => {
    stub({ source: { ...SOURCE, channel: "beta" } });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Update source$/ }));
    const group = await screen.findByRole("radiogroup", { name: "Update channel" });
    expect(within(group).getByRole("radio", { name: "Beta" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Stable" })).not.toBeChecked();
  });

  it("saves a channel change straight away, keeping the rest of the source", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Update source$/ }));
    const group = await screen.findByRole("radiogroup", { name: "Update channel" });
    await user.click(within(group).getByRole("radio", { name: "Beta" }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(puts(fetchMock)[0][1].body)).toEqual({
      feed_url: DEFAULTS.feed_url,
      channel: "beta",
      keys: [],
    });
  });

  it("says so when the channel could not be saved", async () => {
    stub({ onPut: () => json({ error: "Pick Stable or Beta as the update channel." }, 400) });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Update source$/ }));
    const group = await screen.findByRole("radiogroup", { name: "Update channel" });
    await user.click(within(group).getByRole("radio", { name: "Beta" }));
    expect(await screen.findByText("Pick Stable or Beta as the update channel.")).toBeInTheDocument();
  });

  it("explains each field problem in plain words before saving", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);

    const feed = dialog.querySelector("#us-feed-url");
    await user.clear(feed);
    await user.type(feed, "ftp://nope");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("The feed address must start with http:// or https://.")).toBeInTheDocument();

    await user.clear(feed);
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/The feed address needs a value/)).toBeInTheDocument();

    await user.type(feed, "https://feeds.example.net/feeds");
    const keys = dialog.querySelector("#us-keys");
    await user.clear(keys);
    await user.type(keys, "not a key");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/not a valid minisign public key/)).toBeInTheDocument();

    expect(puts(fetchMock)).toHaveLength(0);
  });

  it("has nothing about repos, owners or fetching keys from a project page", async () => {
    stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    expect(within(dialog).queryByLabelText("Owner")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Fetch from repo/ })).toBeNull();
    expect(within(dialog).queryByText(/repo/i)).toBeNull();
  });

  it("saves the edited feed address, sending no keys when the built-in one is kept", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    const feed = dialog.querySelector("#us-feed-url");
    await user.clear(feed);
    await user.type(feed, "https://friends.example.net/feeds");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(puts(fetchMock)[0][1].body)).toEqual({
      feed_url: "https://friends.example.net/feeds",
      channel: "stable",
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
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(puts(fetchMock)[0][1].body).keys).toEqual(["RWOTHERSIGNER"]);
  });

  it("keeps Save off until something changes, and Use defaults restores the shipped values", async () => {
    stub({ source: { ...SOURCE, feed_url: "https://staging.example.net/feeds" } });
    const user = userEvent.setup();
    renderCard();
    const dialog = await openEditor(user);
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Use defaults" }));
    expect(dialog.querySelector("#us-feed-url")).toHaveValue(DEFAULTS.feed_url);
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
