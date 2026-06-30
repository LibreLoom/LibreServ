import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  mockVerify,
  mockRecover,
  mockChallenge,
  mockAddToast,
  mockOnSuccess,
  fakeCredentialsGet,
} = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockRecover: vi.fn(),
  mockChallenge: vi.fn(),
  mockAddToast: vi.fn(),
  mockOnSuccess: vi.fn(),
  fakeCredentialsGet: vi.fn(),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    mfaChallenge: mockChallenge,
    mfaVerify: mockVerify,
    mfaRecover: mockRecover,
  }),
}));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

import MfaChallenge from "./MfaChallenge";

const TOKEN = "mfa-token-abc";
const METHODS = [
  { type: "totp", label: "Authenticator app" },
  { type: "email", label: "Email code" },
  { type: "passkey", label: "Passkey" },
];

function renderChallenge(methods = METHODS) {
  return render(<MfaChallenge mfaToken={TOKEN} methods={methods} onSuccess={mockOnSuccess} onBack={() => {}} />);
}

function fakeCredential() {
  return {
    id: "cred-id",
    rawId: new ArrayBuffer(8),
    type: "public-key",
    response: {
      authenticatorData: new ArrayBuffer(8),
      clientDataJSON: new ArrayBuffer(8),
      signature: new ArrayBuffer(8),
      userHandle: null,
    },
  };
}

describe("MfaChallenge", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    mockRecover.mockReset();
    mockChallenge.mockReset();
    mockOnSuccess.mockReset();
    mockAddToast.mockReset();
    fakeCredentialsGet.mockReset();
    // jsdom has no navigator.credentials — install the WebAuthn entry point.
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: { get: fakeCredentialsGet },
      configurable: true,
      writable: true,
    });
  });

  it("lists the user's enabled methods to pick from", () => {
    renderChallenge();
    expect(screen.getByText("Authenticator app")).toBeInTheDocument();
    expect(screen.getByText("Email code")).toBeInTheDocument();
    expect(screen.getByText("Passkey")).toBeInTheDocument();
    expect(screen.getByText(/Use a recovery code instead/i)).toBeInTheDocument();
  });

  it("verifies a TOTP code and completes login", async () => {
    mockVerify.mockResolvedValueOnce(undefined);
    renderChallenge();
    fireEvent.click(screen.getByText("Authenticator app"));
    const input = await screen.findByPlaceholderText(/6-digit code/i);
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() =>
      expect(mockVerify).toHaveBeenCalledWith(TOKEN, "totp", { code: "123456" }),
    );
    await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
  });

  it("verifies an email code (the default method) with the email type", async () => {
    mockVerify.mockResolvedValueOnce(undefined);
    renderChallenge();
    fireEvent.click(screen.getByText("Email code"));
    const input = await screen.findByPlaceholderText(/code from your email/i);
    fireEvent.change(input, { target: { value: "999111" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() =>
      expect(mockVerify).toHaveBeenCalledWith(TOKEN, "email", { code: "999111" }),
    );
    await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
  });

  it("recovers with a recovery code (fallback when a device is lost)", async () => {
    mockRecover.mockResolvedValueOnce(undefined);
    renderChallenge();
    fireEvent.click(screen.getByText(/Use a recovery code instead/i));
    const input = await screen.findByPlaceholderText(/Enter a recovery code/i);
    fireEvent.change(input, { target: { value: "RECOVERY-1" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(mockRecover).toHaveBeenCalledWith(TOKEN, "RECOVERY-1"));
    await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
  });

  it("shows an error on bad code without completing login (no softlock — user retries)", async () => {
    const err = Object.assign(new Error("bad code"), { cause: { status: 401 } });
    mockVerify.mockRejectedValueOnce(err);
    renderChallenge();
    fireEvent.click(screen.getByText("Authenticator app"));
    const input = await screen.findByPlaceholderText(/6-digit code/i);
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() =>
      expect(screen.getByText(/That code didn't work/i)).toBeInTheDocument(),
    );
    expect(mockOnSuccess).not.toHaveBeenCalled();
  });

  it("drives a passkey via WebAuthn (challenge → navigator.credentials.get → verify)", async () => {
    mockChallenge.mockResolvedValueOnce({ options: { publicKey: { challenge: "AAAAAAAAAAAAAAAA", allowCredentials: [] } } });
    fakeCredentialsGet.mockResolvedValueOnce(fakeCredential());
    mockVerify.mockResolvedValueOnce(undefined);
    renderChallenge();
    fireEvent.click(screen.getByText("Passkey"));
    await waitFor(() => expect(mockChallenge).toHaveBeenCalledWith(TOKEN, "passkey"));
    await waitFor(() => expect(fakeCredentialsGet).toHaveBeenCalled());
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith(TOKEN, "passkey", expect.any(Object)));
    await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
  });
});