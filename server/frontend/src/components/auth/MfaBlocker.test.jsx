import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock MfaCard so the blocker test stays focused on the wrapper (the MfaCard
// enrollment flow has its own tests). Capture the onMethodEnabled prop.
const captured = vi.hoisted(() => ({ onMethodEnabled: null }));
vi.mock("../profile/MfaCard", () => ({
  __esModule: true,
  default: (/** @type {{ onMethodEnabled: Function }} */ props) => {
    captured.onMethodEnabled = props.onMethodEnabled;
    return <button data-testid="mock-mfacard" onClick={() => props.onMethodEnabled?.()}>mock</button>;
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

  it("passes an onMethodEnabled handler to MfaCard (clears the blocker on enroll)", () => {
    render(<MfaBlocker />);
    expect(captured.onMethodEnabled).toBeInstanceOf(Function);
    // jsdom's location.reload is a safe no-op — calling the handler must not throw.
    expect(() => fireEvent.click(screen.getByTestId("mock-mfacard"))).not.toThrow();
  });
});