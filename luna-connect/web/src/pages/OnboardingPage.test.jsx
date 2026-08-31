import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingPage from "./OnboardingPage.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { ThemeProvider } from "../context/ThemeContext.jsx";

const register = vi.fn();
const login = vi.fn();
const refresh = vi.fn();
const markEmailVerified = vi.fn();
const updateAccountEmail = vi.fn();
const authState = vi.hoisted(() => ({ isAuthenticated: false, me: null }));

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../billing/stripeConfig.js", () => ({
  stripeLooksConfigured: vi.fn(() => false),
}));

vi.mock("../components/VerifyHumanCard.jsx", () => ({
  VerifyHumanCard: ({ onConfirm, loading }) => (
    <button type="button" disabled={loading} onClick={() => onConfirm("pm_test_diy")}>
      Confirm with a dollar
    </button>
  ),
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    register,
    login,
    me: authState.me,
    refresh,
    refreshMe: refresh,
    markEmailVerified,
    updateAccountEmail,
  }),
}));

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function mount(path = "/onboarding") {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <OnboardingPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillAccount(email, password) {
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
  fireEvent.change(await screen.findByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

async function createDiyAccount() {
  mount("/diyonboarding");
  await fillAccount("me@example.com", "password1234");
}

describe("OnboardingPage DIY verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = false;
    authState.me = null;
    register.mockResolvedValue({ email: "me@example.com", email_verified: true });
    login.mockResolvedValue({ email: "me@example.com", email_verified: true });
    refresh.mockImplementation(async () => authState.me);
    updateAccountEmail.mockResolvedValue({});
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy", message: "Put this on Luna." };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
  });

  it("waits for email verification before continuing a new account", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    await createDiyAccount();

    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();
    expect(screen.getByText(/Want to change your email\?/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Go Back/i })).toBeTruthy();
    expect(api.mock.calls.map((call) => call[0])).not.toContain("/api/v1/account/verify-human");
    expect(api.mock.calls.map((call) => call[0])).not.toContain("/api/v1/account/diy-token");
  });

  it("returns to Change your email address from the inbox wait screen with email prefilled", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "me@example.com", email_verified: false };
    mount("/diyonboarding");

    expect(await screen.findByRole("heading", { name: "Change your email address" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue to verification/i }));

    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();
    expect(screen.getByText(/Want to change your email\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Go Back/i }));

    expect(await screen.findByRole("heading", { name: "Change your email address" })).toBeTruthy();
    expect(screen.getByLabelText(/email address/i).value).toBe("me@example.com");
    expect(screen.getByRole("button", { name: /Continue to verification/i })).toBeTruthy();
  });

  it("shows Change your email address for a signed-in unverified account", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: false };
    mount("/diyonboarding");

    expect(await screen.findByRole("heading", { name: "Change your email address" })).toBeTruthy();
    expect(screen.getByLabelText(/email address/i).value).toBe("owner@example.com");
    expect(screen.getByText(/Fix the address here if there is a typo/i)).toBeTruthy();
  });

  it("continues after the email verification check succeeds", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: true };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();

    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(markEmailVerified).toHaveBeenCalled();
  });

  it("does not charge again when the signed-in account is already human-verified", async () => {
    authState.isAuthenticated = true;
    authState.me = {
      email: "owner@example.com",
      email_verified: true,
      human_verified: true,
      stripe_publishable_key: "pk_test_x",
    };
    stripeLooksConfigured.mockReturnValue(true);
    mount("/diyonboarding");
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(api.mock.calls.map((call) => call[0])).not.toContain("/api/v1/account/verify-human");
  });

  it("starts /onboarding on a welcome step, not a register form", () => {
    mount();
    expect(screen.getByRole("heading", { name: /Set up your Luna/i })).toBeTruthy();
    expect(screen.getByText(/recommended way to set up Luna/i)).toBeTruthy();
    expect(screen.getByText(/quick-start guide/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Get Started/i })).toBeTruthy();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /set this computer up myself/i })).toBeNull();
  });

  it("starts /diyonboarding on the bring-your-own account step", () => {
    mount("/diyonboarding");
    expect(screen.getByRole("heading", { name: /Set up your own hardware/i })).toBeTruthy();
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    expect(screen.queryByText(/booklet/i)).toBeNull();
  });

  it("shows Password placeholder, helper copy, and live requirement chips while typing", async () => {
    mount("/diyonboarding");
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    const passwordInput = await screen.findByLabelText(/password/i);
    expect(passwordInput.getAttribute("placeholder")).toBe("Password");
    expect(
      screen.getByText("Use at least 12 characters, including a letter and a number."),
    ).toBeTruthy();

    fireEvent.change(passwordInput, { target: { value: "abc" } });
    expect(screen.getByText("12+ chars")).toBeTruthy();
    expect(screen.getByText("letters")).toBeTruthy();
    expect(screen.getByText("numbers")).toBeTruthy();
    expect(screen.getByText("symbols")).toBeTruthy();
    expect(screen.getByText("Not strong enough yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i }).disabled).toBe(true);

    fireEvent.change(passwordInput, { target: { value: "password1234" } });
    expect(screen.getByText("✓ Acceptable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i }).disabled).toBe(false);
  });

  it("does not call verify-human before a card action when Stripe looks configured", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    await createDiyAccount();

    await waitFor(() => {
      expect(register).toHaveBeenCalled();
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/account/verify-human");
    expect(screen.getByRole("button", { name: /confirm with a dollar/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirm with a dollar/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/verify-human", {
        method: "POST",
        body: JSON.stringify({ payment_method_id: "pm_test_diy" }),
      });
    });
    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
  });

  it("skips the card step when Stripe is not configured and still mints a code", async () => {
    stripeLooksConfigured.mockReturnValue(false);
    await createDiyAccount();

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/verify-human", {
        method: "POST",
        body: "{}",
      });
    });
    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });

  it("keeps the official path free of a card step and binds after account", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/bind") return { device_id: "dev_1", already_bound: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    });
    await fillAccount("owner@example.com", "password1234");

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device code$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Device code$/i), {
      target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/bind", {
        method: "POST",
        body: JSON.stringify({ code: "ABCD-EFGH-IJKM-NPQR-STUV" }),
      });
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/account/verify-human");
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
  });
});

describe("OnboardingPage done card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/bind") return { device_id: "dev_1", already_bound: false };
      if (path === "/api/v1/devices/dev_1/domain") {
        return {
          device_id: "dev_1",
          hostname: "kitchen.luna.servers.libreloom.org",
          subdomain: "kitchen",
          setup_secret: "once-only-code",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
  });

  it("shows the hostname and one-time code after name is taken", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device code$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Device code$/i), {
      target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Name$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: "kitchen" } });
    fireEvent.click(screen.getByRole("button", { name: /Use this name/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Skip for now/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Skip for now/i }));

    expect(await screen.findByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("once-only-code")).toBeTruthy();
    expect(screen.getByText(/paste this one-time code/i)).toBeTruthy();
    expect(screen.getByText(/Create your Luna login and paste the code once/i)).toBeTruthy();
    expect(screen.getByText(/Luna applies these settings when it is online/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\?setup=/);
  });

  it("goes straight to name after bind without waiting for Luna", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device code$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Device code$/i), {
      target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(screen.queryByText(/Waiting for Luna/i)).toBeNull();
  });
});
