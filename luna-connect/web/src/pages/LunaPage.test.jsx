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

describe("LunaPage pairing remint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.me = { email: "owner@example.com", activated: false };
    api.mockResolvedValue({ devices: [] });
  });

  it("sends unactivated owners to booklet or bring-your-own setup", async () => {
    mount();
    expect(await screen.findByText(/No Luna is connected yet/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Start setup/i }).getAttribute("href")).toBe("/onboarding");
    expect(screen.getByRole("link", { name: /I set this computer up myself/i }).getAttribute("href")).toBe("/register");
    expect(screen.queryByRole("button", { name: /Get a new setup code/i })).toBeNull();
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
});
