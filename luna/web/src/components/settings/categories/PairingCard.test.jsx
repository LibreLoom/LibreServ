import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import PairingCard from "./PairingCard.jsx";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

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
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PairingCard />
        </QueryClientProvider>
      </MemoryRouter>
      <Toaster />
    </ToastProvider>,
  );
}

describe("PairingCard", () => {
  beforeEach(() => {
    mockRole = "admin";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("points to Open Luna Connect when the device token is set", async () => {
    stubApi();
    renderCard();

    expect(await screen.findByText("Not paired")).toBeInTheDocument();
    expect(screen.getByText("Enter the device token in your Luna Connect account.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Luna Connect/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /token/i })).not.toBeInTheDocument();
  });

  it("sends an Admin to Settings → About → Advanced when no device token is set", async () => {
    stubApi({ ...BASE_STATUS, device_token_set: false });
    renderCard();

    expect(await screen.findByText("Set the device token in Settings → About → Advanced first.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Device token/i })).toHaveAttribute("href", "/settings#about");
    expect(screen.queryByRole("link", { name: /Open Luna Connect/i })).not.toBeInTheDocument();
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

  it("shows revoked recovery guidance", async () => {
    stubApi({ ...BASE_STATUS, state: "revoked", paired: false, connect_active: false });
    renderCard();

    expect(await screen.findByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByText(/Reconnect it from Devices in your Connect account/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("shows a Member no Admin actions", async () => {
    mockRole = "member";
    const fetchMock = stubApi();
    renderCard();
    expect(await screen.findByText("An Admin can pair this Luna from Luna Connect.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
