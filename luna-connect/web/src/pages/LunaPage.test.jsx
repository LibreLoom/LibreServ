import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LunaPage from "./LunaPage.jsx";
import { api } from "../api.js";

const authState = vi.hoisted(() => ({ me: { email: "owner@example.com", activated: false } }));

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    me: authState.me,
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

describe("LunaPage one Luna", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.me = { email: "owner@example.com", activated: false };
    api.mockResolvedValue({ devices: [] });
  });

  it("sends unactivated owners to booklet or bring-your-own setup", async () => {
    mount();
    expect(await screen.findByText(/This Luna is not paired yet/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /This Luna/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Start setup/i }).getAttribute("href")).toBe("/onboarding");
    expect(screen.getByRole("link", { name: /I set this computer up myself/i }).getAttribute("href")).toBe("/register");
    expect(screen.queryByRole("button", { name: /Get a new setup code/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Setup" })).toBeNull();
    expect(screen.queryByText(/Your Lunas/i)).toBeNull();
    expect(screen.queryByText(/Connect another Luna/i)).toBeNull();
    expect(screen.queryByText(/Loading your Lunas/i)).toBeNull();
  });

  it("lets an activated account mint a new setup code after reset", async () => {
    authState.me = { email: "owner@example.com", activated: true };
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [] };
      if (path === "/api/v1/account/pairing-token" && opts?.method === "POST") {
        return { code: "AAAA-BBBB-CCCC-DDDD-EEEE", message: "Enter this on Luna." };
      }
      return {};
    });
    mount();
    expect(await screen.findByText(/After a factory reset/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Get a new setup code/i }));
    expect(await screen.findByText("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeTruthy();
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/pairing-token", { method: "POST", body: "{}" });
    });
  });

  it("shows one Luna and never a device list or connect another", async () => {
    authState.me = { email: "owner@example.com", activated: true };
    api.mockResolvedValue({
      devices: [
        { id: "dev_1", hostname: "photos.luna.servers.libreloom.org", name: "Luna" },
        { id: "dev_2", hostname: "extra.luna.servers.libreloom.org", name: "Extra" },
      ],
    });
    mount();
    expect(await screen.findByText("photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.queryByText("extra.luna.servers.libreloom.org")).toBeNull();
    expect(screen.queryByText(/Connect another Luna/i)).toBeNull();
    expect(screen.queryByText(/Your Lunas/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Transfer this Luna/i })).toBeTruthy();
  });

  it("confirms transfer then shows the code once", async () => {
    authState.me = { email: "owner@example.com", activated: true };
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") return { devices: [{ id: "dev_1", hostname: "photos.luna.servers.libreloom.org" }] };
      if (path === "/api/v1/account/transfer-token" && opts?.method === "POST") {
        return { code: "TRAN-SFER-CODE-HERE-0001", message: "Give this code to the new owner." };
      }
      return {};
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Transfer this Luna/i }));
    expect(screen.getByText(/The public address goes away/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Transfer this Luna/i }));
    expect(await screen.findByText("TRAN-SFER-CODE-HERE-0001")).toBeTruthy();
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/transfer-token", { method: "POST", body: "{}" });
    });
  });
});
