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
  authState.isAuthenticated = false;
  authState.me = null;
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

  it("keeps the email field empty when the user clears it", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: false };
    mount("/diyonboarding");

    const input = await screen.findByLabelText(/email address/i);
    expect(input.value).toBe("owner@example.com");

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText(/email address/i).value).toBe("");

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "new" } });
    expect(screen.getByLabelText(/email address/i).value).toBe("new");

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "" } });
    expect(screen.getByLabelText(/email address/i).value).toBe("");
    expect(screen.getByRole("button", { name: /Update email and send link/i }).disabled).toBe(true);
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
    expect(refresh).toHaveBeenCalled();
  });

  it("auto-advances when a later poll detects verification", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    let statusCalls = 0;
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") {
        statusCalls += 1;
        return { email_verified: statusCalls >= 2 };
      }
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "POLL-ADVANCE-CODE-1234-5678", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    expect(await screen.findByText("POLL-ADVANCE-CODE-1234-5678", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("auto-advances when verification completes in another tab", async () => {
    const { EMAIL_VERIFIED_STORAGE_KEY } = await import("../lib/emailVerifiedSync.js");
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: true };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "CROSS-TAB-CODE-1234-5678", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EMAIL_VERIFIED_STORAGE_KEY,
        newValue: "1",
        storageArea: localStorage,
      }),
    );

    expect(await screen.findByText("CROSS-TAB-CODE-1234-5678")).toBeTruthy();
  });

  it("advances when Check again finds the email already verified", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    let statusCalls = 0;
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") {
        statusCalls += 1;
        // First poll(s) still waiting; Check again sees verified.
        return { email_verified: statusCalls > 1 };
      }
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Check again/i }));

    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(screen.queryByText(/already verified/i)).toBeNull();
  });

  it("advances when Resend reports the email is already verified", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === "/api/v1/account/resend-verification") {
        return { email_verified: true, already_verified: true, message: "Your email is already verified." };
      }
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Resend the email/i }));

    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(screen.queryByText(/already verified/i)).toBeNull();
  });

  it("advances when Resend returns a legacy already-verified error", async () => {
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === "/api/v1/account/resend-verification") {
        const err = new Error("Your email is already verified.");
        err.status = 400;
        throw err;
      }
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Resend the email/i }));

    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(screen.queryByText(/already verified/i)).toBeNull();
  });

  it("skips inbox wait after verify when Back to Setup restores the verify step", async () => {
    localStorage.setItem(
      "luna-connect-onboarding-progress",
      JSON.stringify({ step: "verify", path: "diy", email: "owner@example.com" }),
    );
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    refresh.mockResolvedValue({ email: "owner@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: true };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "BACK-TO-SETUP-CODE-1234-5678", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/diyonboarding");

    expect(await screen.findByText("BACK-TO-SETUP-CODE-1234-5678")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Check your inbox/i })).toBeNull();
  });

  it("skips inbox wait on official path after verify when progress still says verify", async () => {
    localStorage.setItem(
      "luna-connect-onboarding-progress",
      JSON.stringify({ step: "verify", path: "official", email: "owner@example.com" }),
    );
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    refresh.mockResolvedValue({ email: "owner@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: true };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/onboarding");

    expect(await screen.findByLabelText(/^Device code$/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Check your inbox/i })).toBeNull();
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

  it("skips device code when account already has a bound Luna on official path", async () => {
    authState.isAuthenticated = true;
    authState.me = {
      email: "owner@example.com",
      email_verified: true,
      onboarding_path: "official",
      onboarding_step: "domain",
      has_bound_device: true,
      skip_code_entry: true,
      onboarding_device_id: "dev_bound",
    };
    refresh.mockResolvedValue(authState.me);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/onboarding");

    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^Device code$/i)).toBeNull();
    expect(screen.queryByText(/already has a Luna/i)).toBeNull();
  });

  it("continues past account to name when Luna is already linked", async () => {
    authState.isAuthenticated = true;
    authState.me = {
      email: "owner@example.com",
      email_verified: true,
      has_bound_device: true,
      skip_code_entry: true,
      onboarding_device_id: "dev_bound",
      onboarding_step: "domain",
    };
    refresh.mockImplementation(async () => authState.me);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/onboarding");

    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/devices/bind");
  });

  it("skips name step when Luna already has an address", async () => {
    authState.isAuthenticated = true;
    authState.me = {
      email: "owner@example.com",
      email_verified: true,
      has_bound_device: true,
      skip_code_entry: true,
      onboarding_device_id: "dev_bound",
      onboarding_step: "backup",
      onboarding_hostname: "kitchen.luna.servers.libreloom.org",
    };
    refresh.mockImplementation(async () => authState.me);
    localStorage.setItem(
      "luna-connect-onboarding-progress",
      JSON.stringify({
        path: "official",
        step: "domain",
        deviceId: "dev_bound",
        name: "kitchen",
      }),
    );
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/onboarding");

    expect(await screen.findByRole("heading", { name: /Optional cloud backup/i })).toBeTruthy();
    expect(
      screen.getByText(/Adding your card allows you to backup files from your Luna to the cloud/i),
    ).toBeTruthy();
    expect(screen.getByTestId("backup-pricing-table")).toBeTruthy();
    expect(screen.getByText(/\$8 \/ terabyte \/ month/i)).toBeTruthy();
    expect(screen.queryByText(/The address stays free if you skip this/i)).toBeNull();
    expect(screen.queryByLabelText(/^Name$/i)).toBeNull();
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/devices/dev_bound/domain");
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

  it("blocks advancing to password when the email already has an account", async () => {
    api.mockImplementation(async (path, opts) => {
      if (path === "/api/v1/account/check-email") {
        const err = new Error("That email already has an account. Sign in instead.");
        err.status = 409;
        throw err;
      }
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/diyonboarding");
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "taken@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    expect(await screen.findByText(/That email already has an account/i)).toBeTruthy();
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledWith("/api/v1/account/check-email", {
      method: "POST",
      body: JSON.stringify({ email: "taken@example.com" }),
    });
  });

  it("checks email availability before showing the password step", async () => {
    mount("/diyonboarding");
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/account/check-email", {
        method: "POST",
        body: JSON.stringify({ email: "me@example.com" }),
      });
    });
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
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
    expect(screen.getByText(/installer asks for your device code/i)).toBeTruthy();
    expect(screen.getByText(/Settings → About → Advanced/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });

  it("binds and goes to name when continuing from the DIY code step", async () => {
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/diy-token") {
        return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", device_id: "dev_diy" };
      }
      if (path === "/api/v1/devices/bind") return { device_id: "dev_diy", already_bound: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/bind", {
        method: "POST",
        body: JSON.stringify({ code: "A1B2-C3D4-E5F6-G7H8-J9K0" }),
      });
    });
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Link this Luna/i })).toBeNull();
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
    expect(screen.getByText(/quick-start card/i)).toBeTruthy();
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

  it("unbinds the linked Luna when returning to the device code step", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    let devices = [];
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/v1/account/devices") return { devices };
      if (path === "/api/v1/devices/bind") {
        devices = [{ id: "dev_1" }];
        return { device_id: "dev_1", already_bound: false };
      }
      if (path === "/api/v1/devices/dev_1" && opts.method === "DELETE") {
        devices = [];
        return { ok: true };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    refresh.mockImplementation(async () => ({
      email: "owner@example.com",
      email_verified: true,
      has_bound_device: devices.length > 0,
    }));

    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    await fillAccount("owner@example.com", "password1234");
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device code$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Device code$/i), {
      target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1", { method: "DELETE" });
    });
    expect(await screen.findByLabelText(/^Device code$/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => {
      expect(api.mock.calls.filter((c) => c[0] === "/api/v1/devices/bind").length).toBe(2);
    });
  });
});

describe("OnboardingPage finish flow", () => {
  async function advanceToBackupStep() {
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
      expect(screen.getByRole("button", { name: /^Nah\.$/i })).toBeTruthy();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    refresh.mockImplementation(async () => authState.me);
    updateAccountEmail.mockResolvedValue({});
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/bind") return { device_id: "dev_1", already_bound: false };
      if (path === "/api/v1/devices/dev_1/domain") {
        return {
          device_id: "dev_1",
          hostname: "kitchen.luna.servers.libreloom.org",
          subdomain: "kitchen",
        };
      }
      if (path === "/api/v1/account/devices") {
        return { devices: [{ id: "dev_1", hostname: "kitchen.luna.servers.libreloom.org", online: true }] };
      }
      if (path === "/api/v1/account/devices/dev_1/setup-readiness") {
        return {
          ready: true,
          online: true,
          has_tunnel: true,
          reachable: true,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
  });

  it("skips the plug-in step and shows the simplified done card when Luna is already online", async () => {
    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Nah\.$/i }));

    expect(await screen.findByRole("heading", { name: /Complete setup on Luna/i })).toBeTruthy();
    expect(screen.getByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText(/initial connection is complete/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Plug in Luna/i })).toBeNull();
    expect(screen.queryByText(/one-time code/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\?setup=/);
  });

  it("shows the plug-in step when Luna is offline after backup", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/bind") return { device_id: "dev_1", already_bound: false };
      if (path === "/api/v1/devices/dev_1/domain") {
        return {
          device_id: "dev_1",
          hostname: "kitchen.luna.servers.libreloom.org",
          subdomain: "kitchen",
        };
      }
      if (path === "/api/v1/account/devices") {
        return { devices: [{ id: "dev_1", hostname: "kitchen.luna.servers.libreloom.org", online: false }] };
      }
      if (path === "/api/v1/account/devices/dev_1/setup-readiness") {
        return {
          ready: false,
          online: false,
          has_tunnel: true,
          reachable: false,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Nah\.$/i }));

    expect(await screen.findByRole("heading", { name: /Plug in Luna/i })).toBeTruthy();
    expect(screen.getByText(/^Waiting…$/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Complete setup on Luna/i })).toBeNull();
  });

  it("polls device status and advances to the done card when Luna is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let ready = false;
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/bind") return { device_id: "dev_1", already_bound: false };
      if (path === "/api/v1/devices/dev_1/domain") {
        return {
          device_id: "dev_1",
          hostname: "kitchen.luna.servers.libreloom.org",
          subdomain: "kitchen",
        };
      }
      if (path === "/api/v1/account/devices") {
        return {
          devices: [{ id: "dev_1", hostname: "kitchen.luna.servers.libreloom.org", online: ready }],
        };
      }
      if (path === "/api/v1/account/devices/dev_1/setup-readiness") {
        return {
          ready,
          online: ready,
          has_tunnel: true,
          reachable: ready,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Nah\.$/i }));
    expect(await screen.findByRole("heading", { name: /Plug in Luna/i })).toBeTruthy();

    ready = true;
    await vi.advanceTimersByTimeAsync(5000);

    expect(await screen.findByRole("heading", { name: /Complete setup on Luna/i })).toBeTruthy();
    expect(screen.getByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    vi.useRealTimers();
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
    expect(screen.queryByText(/^Waiting…$/)).toBeNull();
  });
});
