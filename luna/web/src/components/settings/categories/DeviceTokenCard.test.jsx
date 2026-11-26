import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import DeviceTokenCard from "./DeviceTokenCard.jsx";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

const TOKEN = "7K4M2Q9XR8N36T5W1PZH";
const BASE_STATUS = {
  state: "unbound",
  paired: false,
  connect_active: false,
  device_token_set: true,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubApi(status = BASE_STATUS) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    if (path === "/api/v1/connect/status") return json(status);
    if (path === "/api/v1/connect/device-token" && method === "PUT") return json({ ok: true });
    if (path === "/api/v1/connect/unbind" && method === "POST") return json({ ok: true });
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
        <DeviceTokenCard />
      </QueryClientProvider>
      <Toaster />
    </ToastProvider>,
  );
}

describe("DeviceTokenCard", () => {
  beforeEach(() => {
    mockRole = "admin";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows that a device token is set without displaying it", async () => {
    stubApi();
    renderCard();

    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.queryByText(/7K4M/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Luna Connect/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("sets the device token locally from Advanced", async () => {
    const fetchMock = stubApi({ ...BASE_STATUS, device_token_set: false });
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Luna Connect/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
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
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Advanced" }));
    expect(screen.getByText(/Connect and remote access do not change/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace token" }));
    expect(await screen.findByRole("dialog", { name: "Replace device token" })).toBeInTheDocument();
  });

  it("requires the Luna password before the separate Disconnect action", async () => {
    const fetchMock = stubApi({ ...BASE_STATUS, state: "bound", paired: true, connect_active: true });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Luna Connect?" });
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    expect(confirm).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/connect/unbind"))).toBe(false);

    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    await user.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/connect/unbind",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "hunter22" }) }),
    ));
  });

  it("shows pending-disconnect messaging and offers a retry", async () => {
    const fetchMock = stubApi({ ...BASE_STATUS, state: "bound", paired: true, connect_active: false, unbind_pending: true });
    renderCard();

    expect(await screen.findByText("Disconnect pending")).toBeInTheDocument();
    expect(screen.getByText(/Remote access and pairing are off/)).toBeInTheDocument();
    expect(screen.getByText(/Cloud backup stays off until then/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry disconnect" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/connect/status",
      expect.objectContaining({ cache: "no-store" }),
    ));
  });

  it("shows revoked recovery guidance and keeps the token replaceable", async () => {
    stubApi({ ...BASE_STATUS, state: "revoked", paired: false, connect_active: false });
    renderCard();

    expect(await screen.findByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByText(/Reconnect it from Devices in your Connect account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Advanced" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("shows a Member the token state but no Admin actions", async () => {
    mockRole = "member";
    const fetchMock = stubApi();
    renderCard();
    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Advanced" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
