import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NetworkStep from "./NetworkStep.jsx";

vi.mock("../../lib/api", () => ({ default: vi.fn() }));

import api from "../../lib/api";

/** @type {any} */
const mockApi = api;

const json = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
});

describe("NetworkStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mount = () => {
    const onContinue = vi.fn();
    render(<NetworkStep name="LibreServ" onContinue={onContinue} />);
    return { onContinue };
  };

  const openWifiModal = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /^connect to wi-fi$/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  };

  it("lets the user continue by cable, with Wi-Fi staying an optional extra", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: true }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({ available: true, networks: [] }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    const { onContinue } = mount();

    expect(await screen.findByRole("heading", { name: /get online/i })).toBeTruthy();
    // Board shows the cable as plugged in.
    expect(await screen.findByText("Plugged in")).toBeTruthy();
    // Online → the single exit is Continue; Wi-Fi stays joinable as an option.
    expect(screen.getByRole("button", { name: /also connect wi-fi \(optional\)/i })).toBeTruthy();
    const cont = await screen.findByRole("button", { name: /^continue/i });
    await userEvent.click(cont);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does not offer Continue while offline and opens Wi-Fi in a modal", async () => {
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

    mount();

    expect(await screen.findByRole("heading", { name: /get online/i })).toBeTruthy();
    // Board shows both paths as not connected.
    expect(await screen.findByText("Not plugged in")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
    // Picker stays in the modal — not inline on the step.
    expect(screen.queryByText("Home Wi-Fi")).toBeNull();
    expect(screen.queryByRole("button", { name: /^continue$/i })).toBeNull();

    await openWifiModal();
    expect(await screen.findByText("Home Wi-Fi")).toBeTruthy();
    expect(screen.getByRole("button", { name: /pick a network above/i })).toBeDisabled();
  });

  it("connects to a network, flips the board, and then offers Continue", async () => {
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
        return Promise.resolve(json({
          available: true,
          connected: true,
          ssid: "Home Wi-Fi",
          ethernet_connected: false,
        }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    const { onContinue } = mount();

    await openWifiModal();
    const network = await screen.findByRole("button", { name: /home wi-fi/i });
    await userEvent.click(network);
    await userEvent.type(await screen.findByPlaceholderText("Wi-Fi password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: /connect to home wi-fi/i }));

    // The board flips to connected, the modal closes, and the single exit appears.
    expect(await screen.findByText("Connected to Home Wi-Fi")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const cont = await screen.findByRole("button", { name: /^continue$/i });
    await userEvent.click(cont);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("asks for a cable when the device has no Wi-Fi hardware", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: false, connected: false, ethernet_connected: false }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({ available: false, networks: [] }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    mount();

    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(await screen.findByText(/plug a cable into the back of libreserv/i)).toBeTruthy();
    // No modal entry and no exit — only the cable gets the device online.
    expect(screen.queryByRole("button", { name: /^connect to wi-fi$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^continue$/i })).toBeNull();
  });

  it("opens and closes the optional Wi-Fi modal while online by cable", async () => {
    mockApi.mockImplementation((path) => {
      if (path === "/setup/wifi/status") {
        return Promise.resolve(json({ available: true, connected: false, ethernet_connected: true }));
      }
      if (path === "/setup/wifi/scan") {
        return Promise.resolve(json({
          available: true,
          networks: [{ ssid: "Home Wi-Fi", signal: -40, encrypted: true }],
        }));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    mount();

    const link = await screen.findByRole("button", { name: /also connect wi-fi \(optional\)/i });
    // Hidden until the user asks for it.
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(link);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText("Home Wi-Fi")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("surfaces a plain-language error on a wrong password", async () => {
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
      if (path === "/setup/wifi/connect") {
        return Promise.resolve(json({ error: "That password didn't work. Check the sticker on your internet box and try again." }, false, 400));
      }
      return Promise.reject(new Error("unexpected path"));
    });

    mount();

    await openWifiModal();
    const network = await screen.findByRole("button", { name: /home wi-fi/i });
    await userEvent.click(network);
    await userEvent.type(await screen.findByPlaceholderText("Wi-Fi password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /connect to home wi-fi/i }));

    expect(await screen.findByText(/that password didn't work/i)).toBeTruthy();
    // Modal stays open so the user can try again.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
