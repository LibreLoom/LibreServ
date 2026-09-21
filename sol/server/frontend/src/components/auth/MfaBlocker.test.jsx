import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the setup wizard so the blocker test stays focused on the wrapper (the
// wizard's enrollment flow has its own tests). Capture the onComplete prop.
const captured = vi.hoisted(() => ({ onComplete: null, logout: null }));
vi.mock("../profile/MfaCard", () => ({
  __esModule: true,
  MfaSetupWizard: (/** @type {{ onComplete: Function }} */ props) => {
    captured.onComplete = props.onComplete;
    return <button data-testid="mock-mfa-wizard" onClick={() => props.onComplete?.()}>mock</button>;
  },
}));
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => {
    captured.logout = captured.logout || vi.fn();
    return {
      refreshAuth: vi.fn(),
      logout: captured.logout,
      me: { username: "carrots", role: "admin" },
    };
  },
}));

import MfaBlocker from "./MfaBlocker";

describe("MfaBlocker", () => {
  it("renders the admin two-factor requirement", () => {
    render(<MfaBlocker />);
    expect(
      screen.getByText(/Turn on two-factor authentication/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/As an admin, your account is a target/i),
    ).toBeInTheDocument();
  });

  it("passes an onComplete handler to the wizard (clears the blocker on enroll)", () => {
    render(<MfaBlocker />);
    expect(captured.onComplete).toBeInstanceOf(Function);
    // Calling the handler must not throw.
    expect(() => fireEvent.click(screen.getByTestId("mock-mfa-wizard"))).not.toThrow();
  });

  it("offers a sign-out escape hatch so the gate never traps the user", () => {
    render(<MfaBlocker />);
    expect(screen.getByText(/Signed in as carrots/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(captured.logout).toHaveBeenCalled();
  });
});
