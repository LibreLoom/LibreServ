import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingPage from "./OnboardingPage.jsx";
import { api } from "../api.js";
import { ThemeProvider } from "../context/ThemeContext.jsx";

const register = vi.fn();
const login = vi.fn();
const refresh = vi.fn();
const markEmailVerified = vi.fn();
const updateAccountEmail = vi.fn();
// stripe: whether this Connect site takes card payments (the account's stripe_enabled).
const authState = vi.hoisted(() => ({ isAuthenticated: false, me: null, stripe: false }));

/** @param {boolean} enabled */
function setStripe(enabled) {
  authState.stripe = enabled;
}

const CHECKOUT = "/api/v1/billing/checkout";
const DEVICE_UID = "7K4M-2Q9X-R8N3-6T5W-1PZH";
const VERIFICATION_CODE = "A3F91C";
const SETUP_GRANT = "one-time-setup-grant";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));


vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    register,
    login,
    me: authState.me && { stripe_enabled: authState.stripe, ...authState.me },
    refresh,
    refreshMe: refresh,
    markEmailVerified,
    updateAccountEmail,
  }),
}));

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  authState.isAuthenticated = false;
  authState.me = null;
  authState.stripe = false;
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

async function fillPairingDetails() {
  fireEvent.change(await screen.findByLabelText(/^Device ID$/i), { target: { value: DEVICE_UID } });
  fireEvent.change(screen.getByLabelText(/^Verification code$/i), { target: { value: VERIFICATION_CODE } });
}

describe("OnboardingPage DIY verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = false;
    authState.me = null;
    register.mockImplementation(async () => ({ email: "me@example.com", email_verified: true, stripe_enabled: authState.stripe }));
    login.mockImplementation(async () => ({ email: "me@example.com", email_verified: true, stripe_enabled: authState.stripe }));
    refresh.mockImplementation(async () => authState.me && { stripe_enabled: authState.stripe, ...authState.me });
    updateAccountEmail.mockResolvedValue({});
    setStripe(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
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
    expect(api.mock.calls.map((call) => call[0])).not.toContain(CHECKOUT);
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    expect(await screen.findByLabelText(/^Device ID$/i, {}, { timeout: 5000 })).toBeTruthy();
  });

  it("auto-advances when verification completes in another tab", async () => {
    const { EMAIL_VERIFIED_STORAGE_KEY } = await import("../lib/emailVerifiedSync.js");
    register.mockResolvedValue({ email: "me@example.com", email_verified: false });
    refresh.mockResolvedValue({ email: "me@example.com", email_verified: true });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: true };
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
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

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Check again/i }));

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Resend the email/i }));

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByRole("heading", { name: /Check your inbox/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Resend the email/i }));

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    mount("/diyonboarding");

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
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
    setStripe(true);
    mount("/diyonboarding");
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
    expect(api.mock.calls.map((call) => call[0])).not.toContain(CHECKOUT);
  });

  it("skips pairing when the account already has a bound Luna", async () => {
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
    expect(screen.queryByLabelText(/^Device ID$/i)).toBeNull();
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
    expect(api.mock.calls.map((c) => c[0])).not.toContain("/api/v1/devices/pair");
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
      screen.getByText(/Add a card to back up the files on Luna to the cloud/i),
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
    api.mockImplementation(async (path, _opts) => {
      if (path === "/api/v1/account/check-email") {
        const err = new Error("That email already has an account. Sign in instead.");
        err.status = 409;
        throw err;
      }
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
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

  it("shows Password placeholder and helper, then hides helper when requirement chips appear", async () => {
    mount("/diyonboarding");
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    const passwordInput = await screen.findByLabelText(/password/i);
    expect(passwordInput.getAttribute("placeholder")).toBe("Password");
    expect(
      screen.getByText("Use at least 12 characters, including a letter and a number."),
    ).toBeTruthy();

    fireEvent.change(passwordInput, { target: { value: "abc" } });
    expect(
      screen.queryByText("Use at least 12 characters, including a letter and a number."),
    ).toBeNull();
    expect(screen.getByText("12+ characters")).toBeTruthy();
    expect(screen.getByText("letters")).toBeTruthy();
    expect(screen.getByText("numbers")).toBeTruthy();
    expect(screen.getByText("symbols")).toBeTruthy();
    expect(screen.getByText("Not strong enough yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i }).disabled).toBe(true);

    fireEvent.change(passwordInput, { target: { value: "password1234" } });
    expect(screen.getByText("✓ Acceptable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i }).disabled).toBe(false);
  });

  it("does not open the $1 check before a card action when Stripe is on", async () => {
    setStripe(true);
    await createDiyAccount();

    await waitFor(() => {
      expect(register).toHaveBeenCalled();
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain(CHECKOUT);
    const pay = await screen.findByRole("button", { name: /Pay \$1 on Stripe/i });
    expect(screen.getByText(/plus any sales tax or VAT/i)).toBeTruthy();

    fireEvent.click(pay);

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(CHECKOUT, {
        method: "POST",
        body: JSON.stringify({ kind: "card_check", return_to: "diyonboarding" }),
      });
    });
    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
  });

  it("finishes the $1 check when Stripe sends the browser back", async () => {
    setStripe(true);
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/billing/checkout/complete") return { ok: true, done: true, kind: "card_check" };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      return {};
    });
    mount("/diyonboarding?step=card&checkout=cs_test_123");

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/billing/checkout/complete", {
        method: "POST",
        body: JSON.stringify({ session_id: "cs_test_123" }),
      });
    });
    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
  });

  it("skips the card step when Stripe is not configured and asks for pairing details", async () => {
    setStripe(false);
    await createDiyAccount();

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(CHECKOUT, {
        method: "POST",
        body: JSON.stringify({ kind: "card_check", return_to: "diyonboarding" }),
      });
    });
    expect(await screen.findByLabelText(/^Device ID$/i)).toBeTruthy();
    expect(screen.getByText(/Enter both values on Luna in Settings → Luna Connect → Device token/i)).toBeTruthy();
    expect(screen.getByLabelText(/^Verification code$/i)).toHaveValue(VERIFICATION_CODE);
    expect(api).toHaveBeenCalledWith("/api/v1/account/diy-token", {
      method: "POST",
      body: "{}",
      cache: "no-store",
    });
    expect(screen.getByRole("button", { name: /Copy Verification code/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay \$1 on Stripe/i })).toBeNull();
  });

  it("starts pairing and goes to name when Luna claims the DIY details", async () => {
    setStripe(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verification-status") return { email_verified: false };
      if (path === CHECKOUT) return { ok: true, done: true, dev: true };
      if (path === "/api/v1/account/diy-token") {
        return { device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE, device_id: "dev_diy" };
      }
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_diy" };
      if (path === "/api/v1/devices/pair/pair_diy") return { status: "bound", device_id: "dev_diy" };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });
    await createDiyAccount();
    expect(await screen.findByLabelText(/^Verification code$/i)).toHaveValue(VERIFICATION_CODE);

    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/pair", {
        method: "POST",
        body: JSON.stringify({ device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE }),
      });
    });
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/api/v1/devices/pair/pair_diy");
    expect(screen.queryByRole("heading", { name: /Link this Luna/i })).toBeNull();
  });

  it("keeps the official path free of a card step and pairs after account", async () => {
    setStripe(true);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
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
      expect(screen.getByLabelText(/^Device ID$/i)).toBeTruthy();
    });
    expect(screen.getByText(/card in Luna's box/i)).toBeTruthy();
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/v1/devices/pair", {
        method: "POST",
        body: JSON.stringify({ device_uid: DEVICE_UID, verification_code: VERIFICATION_CODE }),
      });
    });
    expect(api.mock.calls.map((c) => c[0])).not.toContain(CHECKOUT);
    expect(screen.queryByRole("button", { name: /Pay \$1 on Stripe/i })).toBeNull();
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
  });

  it("keeps both pairing values required and rejects invalid Device ID letters", async () => {
    mount("/onboarding?step=code");
    const pair = screen.getByRole("button", { name: /Pair Luna/i });
    expect(pair).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Device ID$/i), { target: { value: "7K4M2Q9XR8N36T5W1PZU" } });
    fireEvent.change(screen.getByLabelText(/^Verification code$/i), { target: { value: "A3F91C" } });
    expect(pair).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Device ID$/i), { target: { value: DEVICE_UID } });
    expect(pair).toBeEnabled();
  });

  it("polls a waiting pairing and advances only when Luna claims it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      api.mockImplementation(async (path) => {
        if (path === "/api/v1/devices/pair") return { pairing_id: "pair_wait" };
        if (path === "/api/v1/devices/pair/pair_wait") {
          polls += 1;
          return polls === 1
            ? { status: "waiting" }
            : { status: "bound", device_id: "dev_wait" };
        }
        if (path === "/api/v1/onboarding/progress") return { ok: true };
        return {};
      });
      mount("/onboarding?step=code");
      await fillPairingDetails();
      fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

      expect(await screen.findByText(/Waiting for Luna to finish pairing/)).toBeTruthy();
      expect(screen.queryByLabelText(/^Name$/i)).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the form when the pairing attempt expires", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_expired" };
      if (path === "/api/v1/devices/pair/pair_expired") return { status: "unbound" };
      return {};
    });
    mount("/onboarding?step=code");
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

    expect(await screen.findByText(/This pairing expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pair Luna/i })).toBeEnabled();
  });

  it("cancels a waiting pairing attempt", async () => {
    api.mockImplementation(async (path, options) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_cancel" };
      if (path === "/api/v1/devices/pair/pair_cancel" && options?.method === "DELETE") return { ok: true };
      if (path === "/api/v1/devices/pair/pair_cancel") return { status: "waiting" };
      return {};
    });
    mount("/onboarding?step=code");
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));
    expect(await screen.findByText(/Waiting for Luna to finish pairing/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Cancel pairing/i }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/devices/pair/pair_cancel", { method: "DELETE" }));
    expect(await screen.findByRole("button", { name: /Pair Luna/i })).toBeEnabled();
    expect(screen.getByLabelText(/^Device ID$/i)).not.toBeDisabled();
  });

  it("never unlinks the Luna: no Back from the name step once it is linked", async () => {
    setStripe(true);
    let devices = [];
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/v1/account/devices") return { devices };
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") {
        devices = [{ id: "dev_1" }];
        return { status: "bound", device_id: "dev_1" };
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
      expect(screen.getByLabelText(/^Device ID$/i)).toBeTruthy();
    });
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));
    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();

    expect(screen.queryByRole("button", { name: /^Back$/i })).toBeNull();
    expect(api.mock.calls.some(([, opts]) => opts?.method === "DELETE")).toBe(false);
  });
});

describe("OnboardingPage finish flow", () => {
  async function advanceToBackupStep() {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device ID$/i)).toBeTruthy();
    });
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Name$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: "kitchen" } });
    fireEvent.click(screen.getByRole("button", { name: /Use this name/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Skip for now$/i })).toBeTruthy();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    refresh.mockImplementation(async () => authState.me);
    updateAccountEmail.mockResolvedValue({});
    setStripe(false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
      if (path === "/api/v1/devices/dev_1/setup-grant") return { setup_grant: SETUP_GRANT };
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
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));

    expect(await screen.findByRole("heading", { name: /You're connected/i })).toBeTruthy();
    expect(screen.getByText(/Luna is linked to your account/i)).toBeTruthy();
    expect(screen.getByText(/Open this link to finish setup on Luna\./i)).toBeTruthy();
    const lunaLink = await screen.findByRole("link", {
      name: "kitchen.luna.servers.libreloom.org",
    });
    expect(lunaLink.getAttribute("href")).toBe(
      "https://kitchen.luna.servers.libreloom.org/setup#setup_grant=one-time-setup-grant",
    );
    expect(lunaLink.textContent).not.toMatch(/\/setup/i);
    expect(lunaLink.getAttribute("target")).toBe("_blank");
    expect(lunaLink.getAttribute("rel")).toBe("noreferrer");
    expect(lunaLink.className).toMatch(/underline/);
    expect(lunaLink.className).toMatch(/hover:no-underline/);
    expect(screen.getByRole("button", { name: /Copy setup link/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Plug in Luna/i })).toBeNull();
    expect(screen.queryByText(/one-time code/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\?token=/);
    expect(document.body.textContent).not.toMatch(/\?setup=/);
    expect(document.body.textContent).not.toContain(SETUP_GRANT);
    expect(api).toHaveBeenCalledWith("/api/v1/devices/dev_1/setup-grant", {
      method: "POST",
      body: "{}",
      cache: "no-store",
    });

    fireEvent.click(screen.getByRole("button", { name: /Copy setup link/i }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://kitchen.luna.servers.libreloom.org/setup#setup_grant=one-time-setup-grant",
      );
    });
  });

  it("explains a failed setup grant and can make a fresh setup link", async () => {
    const original = api.getMockImplementation();
    let grantCalls = 0;
    api.mockImplementation(async (path, options) => {
      if (path === "/api/v1/devices/dev_1/setup-grant") {
        grantCalls += 1;
        if (grantCalls === 1) throw new Error("Luna Connect could not make a setup link. Try again.");
        return { setup_grant: grantCalls === 2 ? SETUP_GRANT : "new-setup-grant" };
      }
      return original(path, options);
    });
    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));

    expect(await screen.findByText(/could not make a setup link/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    const link = await screen.findByRole("link", { name: "kitchen.luna.servers.libreloom.org" });
    expect(link).toHaveAttribute("href", `https://kitchen.luna.servers.libreloom.org/setup#setup_grant=${SETUP_GRANT}`);

    fireEvent.click(screen.getByRole("button", { name: /Get a new setup link/i }));
    await waitFor(() => expect(screen.getByRole("link", { name: "kitchen.luna.servers.libreloom.org" })).toHaveAttribute(
      "href",
      "https://kitchen.luna.servers.libreloom.org/setup#setup_grant=new-setup-grant",
    ));
    expect(grantCalls).toBe(3);
  });

  it("shows the plug-in step when Luna is offline after backup", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
      if (path === "/api/v1/devices/dev_1/setup-grant") return { setup_grant: SETUP_GRANT };
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
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));

    expect(await screen.findByRole("heading", { name: /Plug in Luna/i })).toBeTruthy();
    expect(screen.getByText(/^Waiting…$/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /You're connected/i })).toBeNull();
    expect(
      screen.queryByText(/setting up its secure address can take a few minutes/i),
    ).toBeNull();
    expect(screen.queryByText(/after 10 minutes, something is wrong/i)).toBeNull();
  });

  it("shows the provisioning address card when Luna is online but tunnel is not ready", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
      if (path === "/api/v1/devices/dev_1/setup-grant") return { setup_grant: SETUP_GRANT };
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
          ready: false,
          online: true,
          has_tunnel: true,
          domain_ready: false,
          reachable: false,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));

    expect(await screen.findByRole("heading", { name: /Making your address\.\.\./i })).toBeTruthy();
    expect(screen.getByText(/Cloudflare is making the address for this Luna/i)).toBeTruthy();
    expect(screen.getByText(/\.luna\.servers\.libreloom\.org/)).toBeTruthy();
  });

  it("shows the finishing up card when domain is provisioned but health probe not ready", async () => {
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
      if (path === "/api/v1/devices/dev_1/setup-grant") return { setup_grant: SETUP_GRANT };
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
          ready: false,
          online: true,
          has_tunnel: true,
          domain_ready: true,
          reachable: false,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));

    expect(await screen.findByRole("heading", { name: /Finishing up\.\.\./i })).toBeTruthy();
    expect(screen.getByText(/Luna is connecting to its new address/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: /Connecting Luna to its web address/i })).toBeTruthy();
    expect(screen.getByLabelText("Cloudflare")).toBeTruthy();
  });

  it("polls device status and advances to the done card when Luna is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let ready = false;
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/devices/pair") return { pairing_id: "pair_1" };
      if (path === "/api/v1/devices/pair/pair_1") return { status: "bound", device_id: "dev_1" };
      if (path === "/api/v1/devices/dev_1/setup-grant") return { setup_grant: SETUP_GRANT };
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
          domain_ready: true,
          reachable: ready,
          hostname: "kitchen.luna.servers.libreloom.org",
        };
      }
      if (path === "/api/v1/onboarding/backups") return { ok: true, enabled: false };
      if (path === "/api/v1/onboarding/progress") return { ok: true };
      return {};
    });

    await advanceToBackupStep();
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now$/i }));
    expect(await screen.findByRole("heading", { name: /Plug in Luna/i })).toBeTruthy();

    ready = true;
    await vi.advanceTimersByTimeAsync(5000);

    expect(await screen.findByRole("heading", { name: /You're connected/i })).toBeTruthy();
    expect(screen.getByText(/Open this link to finish setup on Luna\./i)).toBeTruthy();
    expect(
      (await screen.findByRole("link", { name: "kitchen.luna.servers.libreloom.org" }))
        .getAttribute("href"),
    ).toBe("https://kitchen.luna.servers.libreloom.org/setup#setup_grant=one-time-setup-grant");
    expect(document.body.textContent).not.toMatch(/\/setup/i);
    expect(document.body.textContent).not.toMatch(/\?token=/);
    vi.useRealTimers();
  });

  it("goes to name as soon as Luna claims pairing", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Device ID$/i)).toBeTruthy();
    });
    await fillPairingDetails();
    fireEvent.click(screen.getByRole("button", { name: /Pair Luna/i }));

    expect(await screen.findByLabelText(/^Name$/i)).toBeTruthy();
    expect(screen.queryByText(/^Waiting…$/)).toBeNull();
  });
});
