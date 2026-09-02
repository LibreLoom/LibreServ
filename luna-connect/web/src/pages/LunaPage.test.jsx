import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(await screen.findByText(/No Luna linked yet/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /My Luna/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Start setup/i }).getAttribute("href")).toBe("/onboarding");
    expect(screen.getByRole("link", { name: /I set this computer up myself/i }).getAttribute("href")).toBe(
      "/diyonboarding",
    );
    expect(screen.queryByRole("button", { name: /Get a new setup code/i })).toBeNull();
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

  it("shows one Luna and never a device list or connect another", async () => {
    api.mockResolvedValue({
      devices: [
        { id: "dev_1", hostname: "photos.luna.servers.libreloom.org", online: true, code_hint: "ABCD••••" },
        { id: "dev_2", hostname: "extra.luna.servers.libreloom.org", online: false },
      ],
    });
    mount();
    const hostnameLink = await screen.findByRole("link", { name: "photos.luna.servers.libreloom.org" });
    expect(hostnameLink.getAttribute("href")).toBe("https://photos.luna.servers.libreloom.org");
    expect(hostnameLink.getAttribute("target")).toBe("_blank");
    expect(hostnameLink.getAttribute("rel")).toBe("noreferrer");
    expect(screen.queryByText("extra.luna.servers.libreloom.org")).toBeNull();
    expect(screen.queryByText(/Connect another Luna/i)).toBeNull();
    expect(screen.queryByText(/Your Lunas/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Unbind Luna/i })).toBeTruthy();
  });

  it("reveals the device code and can unbind", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/devices") {
        return { devices: [{ id: "dev_1", hostname: "photos.luna.servers.libreloom.org", online: false }] };
      }
      if (path === "/api/v1/account/devices/dev_1/code") {
        return { code: "AAAA-BBBB-CCCC-DDDD-EEEE" };
      }
      if (path === "/api/v1/devices/dev_1" && opts?.method === "DELETE") {
        return { ok: true };
      }
      return {};
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Show code/i }));
    expect(await screen.findByText("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Hide code/i }));
    expect(screen.queryByText("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show code/i }));
    expect(await screen.findByText("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Unbind Luna/i }));
    expect(screen.getByText(/The public address goes away/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Unbind Luna/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1", { method: "DELETE" });
    });
    expect(refreshMe).toHaveBeenCalled();
  });
});
