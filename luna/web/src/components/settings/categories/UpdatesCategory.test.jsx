import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UpdatesCategory from "./UpdatesCategory";

const SOURCE_RESPONSE = {
  api_base: "https://gt.plainskill.net/api/v1",
  owner: "LibreLoom",
  repo: "LibreServ",
  keys: ["RWBUILTIN"],
  default_keys: true,
  defaults: {
    api_base: "https://gt.plainskill.net/api/v1",
    owner: "LibreLoom",
    repo: "LibreServ",
    keys: ["RWBUILTIN"],
  },
};

function stubFetch(sourceBody) {
  return vi.fn(async (path, options) => {
    void options;
    if (path.startsWith("/api/v1/system/updates/source")) {
      return new Response(JSON.stringify(sourceBody ?? SOURCE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // /api/v1/system/updates — no release waiting.
    return new Response(
      JSON.stringify({
        current_version: "0.1.0",
        latest_version: "luna-v0.1.0",
        update_available: false,
        release_notes: "",
        url: "",
        checksum: "",
        binary_name: "lunad-linux-amd64",
        reboot_required: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

function renderPage(fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UpdatesCategory />
    </QueryClientProvider>,
  );
}

describe("UpdatesCategory", () => {
  it("shows the update card and a default-source advanced pill", async () => {
    renderPage(stubFetch());
    expect(await screen.findByText(/latest Luna software/i)).toBeTruthy();
    expect(await screen.findByText("Default source")).toBeTruthy();
    expect(screen.getByText("LibreLoom/LibreServ")).toBeTruthy();
  });

  it("flags a custom source when keys differ from the built-in key", async () => {
    renderPage(stubFetch({
      ...SOURCE_RESPONSE,
      api_base: "https://staging.forgejo.test/api/v1",
      owner: "MyOrg",
      repo: "LunaFork",
      keys: ["RWCUSTOM"],
      default_keys: false,
    }));
    expect(await screen.findByText("Custom source")).toBeTruthy();
    expect(screen.getByText("MyOrg/LunaFork")).toBeTruthy();
  });

  it("opens the edit modal with the warning copy and prefilled fields", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch());
    await screen.findByText("Default source");
    await user.click(screen.getByRole("button", { name: /^Update source$/i }));
    await user.click(screen.getByRole("button", { name: /Edit update source/i }));

    expect(await screen.findByText(/Don't touch these during normal use/i)).toBeTruthy();
    expect(screen.getByText(/not your files or backups/i)).toBeTruthy();
    const apiInput = /** @type {HTMLInputElement} */ (
      screen.getByPlaceholderText("https://gt.plainskill.net/api/v1")
    );
    expect(apiInput.value).toBe("https://gt.plainskill.net/api/v1");
    expect(/** @type {HTMLInputElement} */ (screen.getByPlaceholderText("LibreLoom")).value).toBe("LibreLoom");
    expect(/** @type {HTMLInputElement} */ (screen.getByPlaceholderText("LibreServ")).value).toBe("LibreServ");
    const keysField = /** @type {HTMLTextAreaElement} */ (
      screen.getByRole("textbox", { name: /Signing keys/i })
    );
    expect(keysField.value).toBe("RWBUILTIN");
  });

  it("saves the new source with a PUT and closes the modal", async () => {
    const user = userEvent.setup();
    const fetchImpl = stubFetch();
    renderPage(fetchImpl);
    await screen.findByText("Default source");
    await user.click(screen.getByRole("button", { name: /^Update source$/i }));
    await user.click(screen.getByRole("button", { name: /Edit update source/i }));
    await screen.findByText(/Don't touch these during normal use/i);

    await user.clear(screen.getByPlaceholderText("LibreLoom"));
    await user.type(screen.getByPlaceholderText("LibreLoom"), "MyOrg");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    const calls = /** @type {[string, any][]} */ (fetchImpl.mock.calls);
    const put = calls.find(
      ([path, options]) => path.endsWith("/updates/source") && options?.method === "PUT",
    );
    expect(put).toBeTruthy();
    const body = JSON.parse(put?.[1]?.body ?? "{}");
    expect(body.owner).toBe("MyOrg");
    expect(body.repo).toBe("LibreServ");
    expect(body.keys).toEqual(["RWBUILTIN"]);
  });

  it("blocks a save with an invalid signing key", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch());
    await screen.findByText("Default source");
    await user.click(screen.getByRole("button", { name: /^Update source$/i }));
    await user.click(screen.getByRole("button", { name: /Edit update source/i }));

    const keysField = await screen.findByRole("textbox", { name: /Signing keys/i });
    await user.clear(keysField);
    await user.type(keysField, "not-a-key");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByText(/not a valid minisign public key/i)).toBeTruthy();
  });
});
