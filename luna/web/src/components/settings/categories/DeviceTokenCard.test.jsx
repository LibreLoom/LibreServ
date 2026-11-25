import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import DeviceTokenCard from "./DeviceTokenCard.jsx";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

const UID = "7K4M2Q9XR8N36T5W1PZH";
const CODE = "A3F91C";
const BASE_STATUS = {
  state: "unbound",
  paired: false,
  connect_active: false,
  device_uid: UID,
  verification_code: CODE,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubApi(status = BASE_STATUS) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    if (path === "/api/v1/connect/status") return json(status);
    if (path === "/api/v1/connect/device-token" && method === "POST") return json({ ok: true });
    if (path === "/api/v1/connect/device-token" && method === "DELETE") return json({ ok: true });
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

  it("shows the Device ID and keeps the Verification code hidden until asked", async () => {
    stubApi();
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByLabelText("Device ID")).toHaveValue("7K4M-2Q9X-R8N3-6T5W-1PZH");
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show code" }));
    expect(screen.getByLabelText("Verification code")).toHaveValue(CODE);
    await user.click(screen.getByRole("button", { name: "Hide code" }));
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
  });

  it("restores the original pairing details through Luna", async () => {
    const fetchMock = stubApi({ state: "unbound", paired: false, connect_active: false, device_uid: null, verification_code: null });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Restore details" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore pairing details" });
    await user.type(within(dialog).getByLabelText("Device ID"), UID);
    await user.type(within(dialog).getByLabelText("Verification code"), CODE);
    await user.click(within(dialog).getByRole("button", { name: "Restore details" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/connect/device-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ device_uid: "7K4M2Q9XR8N36T5W1PZH", verification_code: CODE }),
      }),
    ));
    expect(await screen.findByText("Pairing details restored.")).toBeInTheDocument();
  });

  it("removes only the local Verification code and says Connect does not change", async () => {
    const fetchMock = stubApi({ ...BASE_STATUS, state: "bound", paired: true, connect_active: true });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Remove code" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Verification code?" });
    expect(within(dialog).getByText(/Connect and remote access do not change/)).toBeInTheDocument();
    expect(within(dialog).getByText(/restore it from Devices in your Connect account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove code" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/connect/device-token",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/connect/unbind"))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(await screen.findByText("Verification code removed.")).toBeInTheDocument();
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

  it("shows revoked recovery guidance and keeps local pairing details restorable", async () => {
    stubApi({ ...BASE_STATUS, state: "revoked", paired: false, connect_active: false, verification_code: null });
    renderCard();

    expect(await screen.findByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByText(/Reconnect it from Devices in your Connect account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore details" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("shows a Member the public Device ID but no Verification code or Admin actions", async () => {
    mockRole = "member";
    const fetchMock = stubApi();
    renderCard();
    expect(await screen.findByLabelText("Device ID")).toHaveValue("7K4M-2Q9X-R8N3-6T5W-1PZH");
    expect(screen.getByText("Admin only")).toBeInTheDocument();
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
