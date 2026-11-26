import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LunaPage from "./LunaPage.jsx";
import { api } from "../api.js";

const refreshMe = vi.fn();
const authState = vi.hoisted(() => ({ me: { email: "owner@example.com", email_verified: true } }));

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    me: authState.me,
    refreshMe,
    logout: vi.fn(),
  }),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

function mount() {
  return render(
    <MemoryRouter>
      <LunaPage />
    </MemoryRouter>,
  );
}

function boundDevice(overrides = {}) {
  return {
    id: "dev_1",
    state: "bound",
    hostname: "photos.luna.servers.libreloom.org",
    online: true,
    ...overrides,
  };
}

describe("LunaPage one Luna", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.me = { email: "owner@example.com", email_verified: true };
    api.mockResolvedValue({ devices: [] });
  });

  it("sends owners without a Luna to official or bring-your-own setup", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Devices" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Devices" })).toBeTruthy();
    expect(await screen.findByText(/No Luna paired yet/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /My Luna/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Start setup/i }).getAttribute("href")).toBe("/onboarding");
    expect(screen.getByRole("link", { name: /I installed Luna myself/i }).getAttribute("href")).toBe(
      "/diyonboarding",
    );
    expect(screen.queryByRole("button", { name: /Get a new device token/i })).toBeNull();
    expect(screen.queryByText(/Your Lunas/i)).toBeNull();
    expect(screen.queryByText(/Connect another Luna/i)).toBeNull();
  });

  it("shows a resume banner when onboarding is incomplete", async () => {
    authState.me = {
      email: "owner@example.com",
      email_verified: true,
      onboarding_path: "diy",
      onboarding_step: "domain",
    };
    mount();
    expect(await screen.findByText(/You still have setup to finish/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Resume setup/i }).getAttribute("href")).toBe("/diyonboarding");
  });

  it("shows one bound Luna and never a device list or connect another", async () => {
    api.mockResolvedValue({
      devices: [
        boundDevice(),
        boundDevice({ id: "dev_2", hostname: "extra.luna.servers.libreloom.org", online: false }),
      ],
    });
    mount();
    const hostnameLink = await screen.findByRole("link", { name: "photos.luna.servers.libreloom.org" });
    expect(hostnameLink.getAttribute("href")).toBe("https://photos.luna.servers.libreloom.org");
    expect(hostnameLink.getAttribute("target")).toBe("_blank");
    expect(hostnameLink.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByTestId("luna-hostname-hero")).toBeTruthy();
    expect(screen.getByTestId("luna-device-toolbar")).toBeTruthy();
    expect(screen.queryByText("extra.luna.servers.libreloom.org")).toBeNull();
    expect(screen.queryByText(/Connect another Luna/i)).toBeNull();
    expect(screen.queryByText(/Your Lunas/i)).toBeNull();
    expect(screen.getByText("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show token/i })).toBeNull();
  });

  it("shows pairing state without a stale address and cancels only that pairing attempt", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") {
        return { devices: [boundDevice({
          state: "pairing",
          hostname: "stale.luna.servers.libreloom.org",
          online: false,
        })] };
      }
      if (path === "/api/v1/devices/dev_1" && opts?.method === "DELETE") return { ok: true };
      return {};
    });
    mount();
    expect(await screen.findByText("Pairing")).toBeTruthy();
    expect(screen.getByText(/Waiting for Luna to finish pairing/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "stale.luna.servers.libreloom.org" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Disconnect$/ })).toBeNull();

    fireEvent.click(within(screen.getByTestId("luna-device-toolbar")).getByRole("button", { name: "Cancel pairing" }));
    const confirm = screen.getByTestId("luna-disconnect-confirm");
    expect(within(confirm).getByText(/cancels the pairing attempt/i)).toBeTruthy();
    expect(within(confirm).getByText(/pair it again later/i)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel pairing" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1", { method: "DELETE" }));
    expect(await screen.findByText(/No Luna paired yet/i)).toBeTruthy();
    expect(refreshMe).toHaveBeenCalled();
  });

  it.each([undefined, "unknown-state"])("fails closed for missing or unknown production state %s", async (state) => {
    api.mockResolvedValue({ devices: [boundDevice({ state, hostname: "stale.luna.servers.libreloom.org" })] });
    mount();

    expect(await screen.findByTestId("luna-state-unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "stale.luna.servers.libreloom.org" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reconnect/i })).toBeNull();
  });

  it("recovers a revoked Luna with account password step-up", async () => {
    let current = boundDevice({ state: "revoked", online: false });
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [current] };
      if (path === "/api/v1/devices/dev_1/recover" && opts?.method === "POST") {
        current = boundDevice({ state: "pairing", hostname: null, online: false });
        return { pairing_id: "pair_1" };
      }
      return {};
    });
    mount();

    expect(await screen.findByText("Reconnect required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "photos.luna.servers.libreloom.org" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Disconnect$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const form = screen.getByTestId("luna-recover-form");
    const confirm = within(form).getByRole("button", { name: "Reconnect" });
    expect(confirm).toBeDisabled();
    expect(api.mock.calls.some(([path]) => String(path).endsWith("/recover"))).toBe(false);

    fireEvent.change(within(form).getByLabelText("Luna Connect password"), { target: { value: "hunter22" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1/recover", {
      method: "POST",
      body: JSON.stringify({ password: "hunter22" }),
      cache: "no-store",
    }));
    expect(await screen.findByText("Pairing")).toBeTruthy();
    expect(screen.getByText(/Reconnect started/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "photos.luna.servers.libreloom.org" })).toBeNull();
    expect(refreshMe).toHaveBeenCalled();
  });

  it("keeps a revoked Luna disconnected when recovery password is refused", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice({ state: "revoked", online: false })] };
      if (path === "/api/v1/devices/dev_1/recover" && opts?.method === "POST") {
        throw new Error("That password is wrong. This Luna was not recovered.");
      }
      return {};
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    const form = screen.getByTestId("luna-recover-form");
    fireEvent.change(within(form).getByLabelText("Luna Connect password"), { target: { value: "wrong" } });
    fireEvent.click(within(form).getByRole("button", { name: "Reconnect" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/password is wrong/i);
    expect(alert.querySelector("p")).toHaveClass("text-foreground");
    expect(alert.querySelector("p")).not.toHaveClass("text-error");
    expect(screen.getByText("Reconnect required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "photos.luna.servers.libreloom.org" })).toBeNull();
  });

  it("never shows or asks the server for the device token", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice()] };
      return {};
    });
    mount();

    expect(await screen.findByTestId("luna-device-status")).toBeTruthy();
    expect(screen.queryByText(/Device ID|Verification code/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /pairing details/i })).toBeNull();
    expect(api.mock.calls.some(([path]) => String(path).includes("/code") || String(path).includes("/reveal"))).toBe(false);
  });

  it("confirms a reversible Disconnect without exposing a permanent token", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice({ online: false })] };
      if (path === "/api/v1/devices/dev_1" && opts?.method === "DELETE") return { ok: true };
      return {};
    });
    mount();

    fireEvent.click(within(await screen.findByTestId("luna-device-toolbar")).getByRole("button", { name: /Disconnect/i }));
    const confirm = screen.getByTestId("luna-disconnect-confirm");
    expect(within(confirm).getByText(/pair it again later/i)).toBeTruthy();
    expect(within(confirm).getByText(/device token/i)).toBeTruthy();
    expect(api.mock.calls.some(([path]) => String(path).includes("/code"))).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: /Disconnect/i }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1", { method: "DELETE" }));
    expect(refreshMe).toHaveBeenCalled();
  });

  it("offers to cancel billing when disconnecting a paying account", async () => {
    authState.me = { ...authState.me, has_card: true };
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice({ online: false })] };
      if (path === "/api/v1/devices/dev_1" && opts?.method === "DELETE") return { ok: true };
      return {};
    });
    mount();

    fireEvent.click(within(await screen.findByTestId("luna-device-toolbar")).getByRole("button", { name: /Disconnect/i }));
    const confirm = screen.getByTestId("luna-disconnect-confirm");
    expect(within(confirm).getByText(/deletes every cloud backup right away/i)).toBeTruthy();
    expect(within(confirm).getByRole("button", { name: "Disconnect and keep backups" })).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect and cancel billing" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1", {
      method: "DELETE",
      body: JSON.stringify({ cancel_billing: true }),
    }));
  });

  it("keeps a failed Disconnect inside the confirmation", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice()] };
      if (path === "/api/v1/devices/dev_1" && opts?.method === "DELETE") {
        throw new Error("Luna Connect could not disconnect this Luna. Try again.");
      }
      return {};
    });
    mount();
    fireEvent.click(within(await screen.findByTestId("luna-device-toolbar")).getByRole("button", { name: /Disconnect/i }));
    const confirm = screen.getByTestId("luna-disconnect-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: /Disconnect/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not disconnect this Luna/i);
    expect(alert.querySelector("p")).toHaveClass("text-foreground");
    expect(confirm).toBeInTheDocument();
  });

  it("changes the address from the Luna page", async () => {
    let hostname = "photos.luna.servers.libreloom.org";
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice({ hostname })] };
      if (path === "/api/v1/devices/dev_1/domain" && opts?.method === "POST") {
        hostname = `${JSON.parse(opts.body).subdomain}.luna.servers.libreloom.org`;
        return { hostname };
      }
      return {};
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Change address$/i }));
    const input = screen.getByLabelText(/New address/i);
    fireEvent.change(input, { target: { value: "Kitchen" } });
    const save = within(screen.getByTestId("luna-change-address")).getByRole("button", { name: /^Change address$/i });
    fireEvent.click(save);

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1/domain", {
        method: "POST",
        body: JSON.stringify({ subdomain: "kitchen" }),
      });
    });
    expect(await screen.findByText(/Address changed to kitchen\.luna\.servers\.libreloom\.org/i)).toBeTruthy();
  });

  it("shows the reason when the new address is refused", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [boundDevice()] };
      if (opts?.method === "POST") throw new Error("That name is already taken.");
      return {};
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Change address$/i }));
    fireEvent.change(screen.getByLabelText(/New address/i), { target: { value: "taken" } });
    const save = within(screen.getByTestId("luna-change-address")).getByRole("button", { name: /^Change address$/i });
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already taken/i);
    expect(alert.querySelector("p")).toHaveClass("text-foreground");
  });
});
