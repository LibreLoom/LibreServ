import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WifiStep from "./WifiStep.jsx";

vi.mock("../../lib/api", () => ({ default: vi.fn() }));

import api from "../../lib/api";

/** @type {any} */
const mockApi = api;

const json = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
});

describe("WifiStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  const mount = () => {
    const onConnected = vi.fn();
    const onSkipWifi = vi.fn();
    render(<WifiStep onConnected={onConnected} onSkipWifi={onSkipWifi} />);
    return { onConnected, onSkipWifi };
  };

  it("shows the required state when Ethernet is down and offers connect", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: false }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({
          available: true,
          networks: [{ ssid: "Home Wi-Fi", signal: -40, encrypted: true }],
        }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    const { onSkipWifi } = mount();
    void onSkipWifi;

    expect(await screen.findByRole("heading", { name: /connect to wi-fi/i })).toBeTruthy();
    expect(await screen.findByText("Home Wi-Fi")).toBeTruthy();
    // No cable → no skip affordance.
    expect(screen.queryByText(/use the cable instead/i)).toBeNull();
  });

  it("shows the optional state with a skip link when Ethernet is up", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: true }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({ available: true, networks: [] }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    const { onSkipWifi } = mount();
    void onSkipWifi;

    expect(await screen.findByText(/you're connected by cable/i)).toBeTruthy();
    const skip = await screen.findByRole("button", { name: /use the cable instead/i });
    await userEvent.click(skip);
    expect(onSkipWifi).toHaveBeenCalledTimes(1);
  });

  it("connects to a selected network and reports connected", async () => {
    mockApi.mockImplementation((path, opts) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: false }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({
          available: true,
          networks: [{ ssid: "Home Wi-Fi", signal: -40, encrypted: true }],
        }));
      }
      if (path === "/setup/wifi/connect") {
        expect(opts.method).toBe("POST");
        expect(JSON.parse(opts.body)).toEqual({ ssid: "Home Wi-Fi", passphrase: "secret" });
        return Promise.resolve(json({ available: true, connected: true, ssid: "Home Wi-Fi" }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    const { onConnected } = mount();

    const network = await screen.findByRole("button", { name: /home wi-fi/i });
    await userEvent.click(network);
    await userEvent.type(await screen.findByPlaceholderText("Wi-Fi password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: /connect to home wi-fi/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });

  it("surfaces a plain-language error on a wrong password", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: false }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({ available: true, networks: [{ ssid: "Home Wi-Fi", signal: -40, encrypted: true }] }));
      }
      if (path === "/setup/wifi/connect") {
        return Promise.resolve(json({ error: "That password didn't work. Check the sticker on your internet box and try again." }, false, 400));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    mount();

    const network = await screen.findByRole("button", { name: /home wi-fi/i });
    await userEvent.click(network);
    await userEvent.type(await screen.findByPlaceholderText("Wi-Fi password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /connect to home wi-fi/i }));

    expect(await screen.findByText(/that password didn't work/i)).toBeTruthy();
  });
});
