import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingPage from "./OnboardingPage.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { ThemeProvider } from "../context/ThemeContext.jsx";

const register = vi.fn();
const login = vi.fn();
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
    login,
    me: authState.me,
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

async function createOssAccount() {
  fireEvent.click(screen.getByRole("button", { name: /I set this computer up myself/i }));
  await fillAccount("me@example.com", "password1234");
}

describe("OnboardingPage OSS verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = false;
    authState.me = null;
    register.mockResolvedValue({});
    login.mockResolvedValue({});
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/oss-token") return { code: "A1B2-C3D4-E5F6-G7H8-J9K0", message: "Enter this on Luna." };
      if (path === "/api/v1/onboarding/bind") return { message: "ok" };
      if (path === "/api/v1/onboarding/attach-account") return { ok: true };
      return {};
    });
  });

  it("starts on a welcome step, not a register form", () => {
    mount();
    expect(screen.getByRole("heading", { name: /Set up Luna Connect/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /I have a booklet/i })).toBeTruthy();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it("starts /register on the bring-your-own account step", () => {
    mount("/register");
    expect(screen.getByRole("heading", { name: /Set up your own hardware/i })).toBeTruthy();
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /I have a booklet/i })).toBeNull();
  });

  it("does not call verify-human before a card action when Stripe looks configured", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    mount();
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
    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
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
    expect(await screen.findByText("A1B2-C3D4-E5F6-G7H8-J9K0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });

  it("keeps the booklet path free of a card step", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /I have a booklet/i }));
    fireEvent.change(screen.getByLabelText(/device code/i), { target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/email address/i)).toBeTruthy();
    });
    await fillAccount("book@example.com", "password1234");

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
    localStorage.clear();
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
    fireEvent.click(screen.getByRole("button", { name: /I have a booklet/i }));
    fireEvent.change(screen.getByLabelText(/device code/i), { target: { value: "ABCD-EFGH-IJKM-NPQR-STUV" } });
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
    expect(document.body.textContent).not.toMatch(/\?setup=/);
  });
});
