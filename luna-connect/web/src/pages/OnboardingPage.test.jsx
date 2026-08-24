import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingPage from "./OnboardingPage.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";

const register = vi.fn();

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
    isAuthenticated: false,
    register,
    me: null,
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
  fireEvent.click(screen.getByRole("button", { name: /I set this computer up myself/i }));
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenough" } });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

describe("OnboardingPage OSS verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.mockResolvedValue({});
    stripeLooksConfigured.mockReturnValue(false);
    api.mockImplementation(async (path) => {
      if (path === "/api/v1/account/verify-human") return { ok: true };
      if (path === "/api/v1/account/oss-token") return { code: "A1B2C3", message: "Enter this on Luna." };
      if (path === "/api/v1/onboarding/bind") return { message: "ok" };
      if (path === "/api/v1/onboarding/attach-account") return { ok: true };
      return {};
    });
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
    expect(await screen.findByText("A1B2C3")).toBeTruthy();
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
    expect(await screen.findByText("A1B2C3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm with a dollar/i })).toBeNull();
  });

  it("keeps the booklet path free of a card step", async () => {
    stripeLooksConfigured.mockReturnValue(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /I have a booklet/i }));
    fireEvent.change(screen.getByLabelText(/device code/i), { target: { value: "ABCDEF" } });
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
