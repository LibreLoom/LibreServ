import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingPage from "./OnboardingPage.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";

const register = vi.fn();
const authState = vi.hoisted(() => ({ isAuthenticated: false, me: null }));

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../billing/stripeConfig.js", () => ({
  stripeLooksConfigured: vi.fn(() => false),
}));

vi.mock("../components/VerifyHumanCard.jsx", () => ({
  VerifyHumanCard: ({ onConfirm, loading }) => (
    <button type="button" disabled={loading} onClick={() => onConfirm("pm_test_oss")}>
      Confirm with a dollar
    </button>
  ),
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    register,
    me: authState.me,
  }),
}));

function mount() {
  return render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );
}

async function createOssAccount() {
  fireEvent.click(screen.getByRole("button", { name: /I built it myself/i }));
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenough" } });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

describe("OnboardingPage OSS verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAuthenticated = false;
    authState.me = null;
    register.mockResolvedValue({});
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/oss-token") {
        return {
          code: "3097-V4YK-3HYX-2E3P-V4B3",
          message: "On Luna, open the address on the screen and enter this code (****-****-****-****-****).",
        };
      }
      if (path === "/api/v1/onboarding/bind") return { message: "ok" };
      if (path === "/api/v1/onboarding/attach-account") return { ok: true };
      return {};
    });
  });

  it("does not call verify-human before a card action when Stripe looks configured", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    mount();
    expect(screen.getByText(/Where did this Luna originate/i)).toBeTruthy();
    await createOssAccount();

    await waitFor(() => {
      expect(register).toHaveBeenCalled();
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/account/verify-human");
    expect(screen.getByRole("button", { name: /confirm with a dollar/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirm with a dollar/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/verify-human", {
        method: "POST",
        body: JSON.stringify({ payment_method_id: "pm_test_oss" }),
      });
    });
    expect(await screen.findByText("3097-V4YK-3HYX-2E3P-V4B3")).toBeTruthy();
  });

  it("skips the card step when Stripe is not configured and still mints a code", async () => {
    stripeLooksConfigured.mockReturnValue(false);
    mount();
    await createOssAccount();

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/verify-human", {
        method: "POST",
        body: "{}",
      });
    });
    expect(await screen.findByText("3097-V4YK-3HYX-2E3P-V4B3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });

  it("lets a signed-in person continue the built-myself path to the dollar check", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "max@example.com", stripe_publishable_key: "pk_test_x" };
    stripeLooksConfigured.mockReturnValue(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /I built it myself/i }));

    expect(await screen.findByRole("button", { name: /^Continue/i })).toBeTruthy();
    expect(screen.getByText("max@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Continue/i }));

    expect(await screen.findByRole("button", { name: /confirm with a dollar/i })).toBeTruthy();
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/account/verify-human");
  });

  it("keeps the purchased path free of a card step", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Purchased from LibreLoom/i }));
    fireEvent.change(screen.getByLabelText(/device code/i), { target: { value: "3097-V4YK-3HYX-2E3P-V4B3" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "book@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenough" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/account/verify-human");
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });
});

describe("OnboardingPage done card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com" };
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/onboarding/bind") return { status: "attached", message: "ok" };
      if (path === "/api/v1/onboarding/session") return { status: "attached" };
      if (path === "/api/v1/onboarding/attach-account") return { ok: true };
      if (path === "/api/v1/onboarding/name") {
        return {
          device_id: "dev_1",
          hostname: "kitchen.luna.servers.libreloom.org",
          subdomain: "kitchen",
          setup_secret: "once-only-code",
        };
      }
      return {};
    });
  });

  it("shows the hostname and one-time code after name is taken", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Purchased from LibreLoom/i }));
    fireEvent.change(screen.getByLabelText(/device code/i), { target: { value: "3097-V4YK-3HYX-2E3P-V4B3" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Plug Luna in/i })).toBeTruthy();
    });
    const pluggedIn = screen.getByRole("button", { name: /Luna is plugged in/i });
    expect(pluggedIn.disabled).toBe(false);
    fireEvent.click(pluggedIn);

    await waitFor(() => {
      expect(screen.getByLabelText(/Name for this Luna/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/Name for this Luna/i), { target: { value: "kitchen" } });
    fireEvent.click(screen.getByRole("button", { name: /Use this name/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skip for now/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Skip for now/i }));

    expect(await screen.findByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("once-only-code")).toBeTruthy();
    expect(screen.getByText(/paste this one-time code/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\?setup=/);
  });
});
