import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const {
  mockRequest,
  mockAddToast,
  mockAvailability,
  mockLoading,
  mockError,
  mockAuthError,
  mockRefresh,
  mockMe,
} = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockAddToast: vi.fn(),
  mockAvailability: { value: null },
  mockLoading: { value: true },
  mockError: { value: null },
  mockAuthError: { value: false },
  mockRefresh: vi.fn(),
  mockMe: { value: { email: "max@plaiskill.net" } },
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ request: mockRequest, me: mockMe.value, refreshAuth: mockRefresh }),
}));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));
vi.mock("../../hooks/useMfaAvailability", () => ({
  __esModule: true,
  default: () => ({
    availability: mockAvailability.value,
    loading: mockLoading.value,
    error: mockError.value,
    authError: mockAuthError.value,
    refresh: mockRefresh,
  }),
}));

import { MfaSetupWizard } from "./MfaCard";

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

describe("MfaSetupWizard", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockAddToast.mockReset();
    mockRefresh.mockReset();
    mockAvailability.value = null;
    mockLoading.value = true;
    mockError.value = null;
    mockAuthError.value = false;
    mockMe.value = { email: "max@plaiskill.net" };
  });

  it("waits for availability before showing any method option", () => {
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured={false} />);
    expect(screen.getByText(/Checking what's available/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/Add Email code/i)).toBeNull();
    expect(screen.queryByTitle(/Add Authenticator app/i)).toBeNull();
    expect(screen.queryByText(/No two-factor methods are available/i)).toBeNull();
  });

  it("hides email option when the server reports email is unavailable", async () => {
    mockLoading.value = false;
    mockAvailability.value = {
      totp: true,
      email: false,
      passkey: false,
      security_key: false,
    };
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured />);
    await waitFor(() =>
      expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument(),
    );
    expect(screen.queryByTitle(/Add Email code/i)).toBeNull();
    expect(screen.queryByTitle(/Add Passkey/i)).toBeNull();
    expect(screen.queryByTitle(/Add Security key/i)).toBeNull();
  });

  it("shows all configured method options once availability loads", async () => {
    mockLoading.value = false;
    mockAvailability.value = {
      totp: true,
      email: true,
      passkey: true,
      security_key: true,
    };
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured />);
    await waitFor(() =>
      expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument(),
    );
    expect(screen.getByTitle("Add Email code")).toBeInTheDocument();
    expect(screen.getByTitle("Add Passkey")).toBeInTheDocument();
    expect(screen.getByTitle("Add Security key")).toBeInTheDocument();
  });

  it("hides email option in setup when SMTP was skipped, even if backend config has SMTP", async () => {
    mockLoading.value = false;
    mockAvailability.value = {
      totp: true,
      email: true,
      passkey: true,
      security_key: true,
    };
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured={false} />);
    await waitFor(() =>
      expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument(),
    );
    expect(screen.queryByTitle(/Add Email code/i)).toBeNull();
    expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument();
  });

  it("shows a retry button instead of defaulting to all methods on error", async () => {
    mockLoading.value = false;
    mockAvailability.value = null;
    mockError.value = "Couldn't reach the server.";
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured={false} />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't reach the server/i)).toBeInTheDocument(),
    );
    const retry = screen.getByRole("button", { name: /Try again/i });
    expect(retry).toBeInTheDocument();
    expect(screen.queryByTitle(/Add Email code/i)).toBeNull();
    retry.click();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("does not show backup codes again after the user has already saved them", async () => {
    mockLoading.value = false;
    mockAvailability.value = {
      totp: true,
      email: true,
      passkey: true,
      security_key: true,
    };

    mockRequest
      .mockResolvedValueOnce(
        json({
          secret: "TESTSECRET",
          otpauth_uri: "otpauth://totp/test",
          qr_image: "data:image/png;base64,abc",
        }),
      )
      .mockResolvedValueOnce(json({})) // /auth/mfa/totp/verify success
      .mockResolvedValueOnce(json({ codes: ["RC-1", "RC-2", "RC-3", "RC-4"] })); // backup codes

    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured />);
    await waitFor(() =>
      expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTitle("Add Authenticator app"));
    // Should see setup phase now (TOTP QR code)
    await waitFor(() =>
      expect(screen.getByText(/Scan this with your authenticator app/i)).toBeInTheDocument(),
    );

    // Enter a code and verify
    const codeInput = screen.getByLabelText(/6-digit code from your app/i);
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify/i }));

    // Should see backup codes phase after verification
    await waitFor(() => expect(screen.getByText("RC-1")).toBeInTheDocument());
    expect(screen.getByText(/Save your backup codes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I've saved my codes/i }));
    // Should complete the wizard since backup codes were acknowledged
    await waitFor(() =>
      expect(screen.queryByTitle("Add Authenticator app")).not.toBeInTheDocument(),
    );
  });

  it("offers a login redirect when the session expired during setup MFA", async () => {
    mockLoading.value = false;
    mockAvailability.value = null;
    mockError.value = "Session expired. Please log in again.";
    mockAuthError.value = true;

    const onSessionExpired = vi.fn();
    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured={false} onSessionExpired={onSessionExpired} />);

    await waitFor(() =>
      expect(screen.getByText(/Session expired/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();

    const loginButton = screen.getByRole("button", { name: /Log in again/i });
    fireEvent.click(loginButton);
    expect(onSessionExpired).toHaveBeenCalled();
  });

  it("shows the pill with the code's email and lets the user change it mid-step", async () => {
    mockLoading.value = false;
    mockAvailability.value = {
      totp: true,
      email: true,
      passkey: true,
      security_key: true,
    };

    mockRequest.mockResolvedValueOnce(json({})); // POST /auth/mfa/email/setup (auto-send)

    render(<MfaSetupWizard onComplete={vi.fn()} smtpConfigured />);
    fireEvent.click(await screen.findByTitle("Add Email code"));

    // Pill shows where the code went.
    expect(await screen.findByText(/Code sent to max@plaiskill.net/i)).toBeInTheDocument();

    // Change → modal → new address → save.
    fireEvent.click(screen.getByRole("button", { name: /Change email address/i }));
    const emailInput = within(screen.getByRole("dialog")).getByRole("textbox");
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    mockRequest.mockResolvedValueOnce(json({ email: "new@example.com" })); // PUT /auth/profile
    mockRefresh.mockImplementation(() => {
      mockMe.value = { email: "new@example.com" }; // what /auth/me would return
    });
    mockRequest.mockResolvedValueOnce(json({})); // POST /auth/mfa/email/setup (re-send)
    fireEvent.click(screen.getByRole("button", { name: /Save & send new code/i }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(
        "/auth/profile",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Code sent to new@example.com." }),
    );
    expect(screen.queryByText(/Change your email/i)).toBeNull(); // modal closed
  });
});