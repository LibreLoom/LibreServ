import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { mockRequest, mockAddToast, mockMe, mockAvailability } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockAddToast: vi.fn(),
  mockMe: vi.fn(),
  mockAvailability: { value: { totp: true, email: true, passkey: true, security_key: true } },
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ me: mockMe(), request: mockRequest }),
}));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));
vi.mock("../../hooks/useMfaAvailability", () => ({
  __esModule: true,
  default: () => ({
    // Default: every method is available so existing tests see all options.
    // Tests that need to assert hiding set mockAvailability.value per-test.
    availability: mockAvailability.value,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import MfaCard from "./MfaCard";

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function primeMethods(methods, remaining = 0, role = "user") {
  mockMe.mockReturnValue({ role });
  mockRequest.mockResolvedValueOnce(json({ methods })); // GET /auth/mfa/methods
  mockRequest.mockResolvedValueOnce(json({ remaining })); // GET /auth/mfa/recovery-codes
}

describe("MfaCard", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockAddToast.mockReset();
    mockMe.mockReset();
    mockAvailability.value = { totp: true, email: true, passkey: true, security_key: true };
  });

  it("lists enabled two-factor methods + recovery count", async () => {
    primeMethods(
      [
        { id: "m1", type: "totp", label: "Authenticator app", enabled: true, last_used_at: null },
        { id: "m2", type: "email", label: "Email code", enabled: true, last_used_at: null },
      ],
      3,
    );
    render(<MfaCard />);
    await waitFor(() => expect(screen.getByText(/3 left/i)).toBeInTheDocument());
    expect(screen.getByLabelText("Remove Authenticator app")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove Email code")).toBeInTheDocument();
  });

  it("removes a method when more than one is enabled", async () => {
    primeMethods([
      { id: "m1", type: "totp", enabled: true },
      { id: "m2", type: "email", enabled: true },
    ]);
    // DELETE ok, then loadMethods refetch (GET /auth/mfa/methods).
    mockRequest.mockResolvedValueOnce(json({ message: "MFA method removed." }));
    mockRequest.mockResolvedValueOnce(json({ methods: [{ id: "m2", type: "email", enabled: true }] }));
    render(<MfaCard />);
    const removeBtns = await screen.findAllByLabelText(/Remove/);
    fireEvent.click(removeBtns[0]);
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
  });

  it("refuses to remove the last method on 409 (no softlock)", async () => {
    primeMethods([{ id: "m1", type: "totp", enabled: true }]);
    const err = Object.assign(new Error("You can't remove your only MFA method."), {
      cause: { status: 409 },
    });
    mockRequest.mockRejectedValueOnce(err);
    render(<MfaCard />);
    const removeBtn = await screen.findByLabelText(/Remove/);
    fireEvent.click(removeBtn);
    await waitFor(() =>
      expect(screen.getByText(/can't remove your only/i)).toBeInTheDocument(),
    );
  });

  it("warns an admin with no MFA to enable one", async () => {
    primeMethods([], 0, "admin");
    render(<MfaCard />);
    await waitFor(() =>
      expect(screen.getByText(/As an admin, you must enable/i)).toBeInTheDocument(),
    );
  });

  it("generates recovery codes and shows them once", async () => {
    primeMethods([{ id: "m1", type: "totp", enabled: true }]);
    mockRequest.mockResolvedValueOnce(json({ codes: ["RC-1", "RC-2", "RC-3"] }));
    render(<MfaCard />);
    const gen = await screen.findByRole("button", { name: /generate/i });
    fireEvent.click(gen);
    await waitFor(() => expect(screen.getByText("RC-1")).toBeInTheDocument());
    expect(screen.getByText("RC-3")).toBeInTheDocument();
  });

  it("hides add-method options the server can't service (e.g. email)", async () => {
    primeMethods([], 0, "admin");
    // Only TOTP is available — email/passkey/security_key are hidden.
    mockAvailability.value = { totp: true, email: false, passkey: false, security_key: false };
    render(<MfaCard />);
    // The add-method tiles carry title="Add <label>". Wait for the one
    // available method to render, then assert the others are absent.
    await waitFor(() =>
      expect(screen.getByTitle("Add Authenticator app")).toBeInTheDocument(),
    );
    expect(screen.queryByTitle(/Add Email code/i)).toBeNull();
    expect(screen.queryByTitle(/Add Passkey/i)).toBeNull();
    expect(screen.queryByTitle(/Add Security key/i)).toBeNull();
  });
});