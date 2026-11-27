import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import DeviceTokenAdvanced from "./DeviceTokenAdvanced.jsx";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

const TOKEN = "7K4M2Q9XR8N36T5W1PZH";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubApi(tokenSet = true) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    if (path === "/api/v1/connect/status") return json({ state: "unbound", device_token_set: tokenSet });
    if (path === "/api/v1/connect/device-token" && method === "PUT") return json({ ok: true });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <DeviceTokenAdvanced />
      </QueryClientProvider>
      <Toaster />
    </ToastProvider>,
  );
}

describe("DeviceTokenAdvanced", () => {
  beforeEach(() => {
    mockRole = "admin";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows that a device token is set without displaying it", async () => {
    stubApi();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Device token" }));
    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.queryByText(/7K4M/)).not.toBeInTheDocument();
  });

  it("sets the device token locally", async () => {
    const fetchMock = stubApi(false);
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Device token" }));
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set token" }));
    const dialog = await screen.findByRole("dialog", { name: "Set device token" });
    const save = within(dialog).getByRole("button", { name: "Save token" });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Device token"), "7k4m-2q9x-r8n3-6t5w-1pzh");
    await user.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/connect/device-token",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ device_token: TOKEN }) }),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/connect/unbind"))).toBe(false);
    expect(await screen.findByText("Device token saved.")).toBeInTheDocument();
  });

  it("offers to replace an existing token and says Connect does not change", async () => {
    stubApi();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Device token" }));
    expect(screen.getByText(/Connect and remote access do not change/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace token" }));
    expect(await screen.findByRole("dialog", { name: "Replace device token" })).toBeInTheDocument();
  });

  it("shows a Member the token state but no set or replace action", async () => {
    mockRole = "member";
    const fetchMock = stubApi();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Device token" }));
    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set token" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
