import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock("../lib/api", () => ({ __esModule: true, default: mockApi }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ token: "tok123" }) }));

import InviteeOnboardingPage from "./InviteeOnboardingPage";

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

describe("InviteeOnboardingPage", () => {
  beforeEach(() => {
    mockApi.mockReset();
  });

  it("shows the onboarding form for a valid invite", async () => {
    mockApi.mockResolvedValueOnce(json({ email: "a@b.com", role: "user", valid: true }));
    render(<InviteeOnboardingPage />);
    await waitFor(() =>
      expect(screen.getByText(/You're invited to join/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/a@b.com/)).toBeInTheDocument();
  });

  it("shows an invalid-invite message when valid=false", async () => {
    mockApi.mockResolvedValueOnce(json({ valid: false }));
    render(<InviteeOnboardingPage />);
    await waitFor(() =>
      expect(screen.getByText(/isn't valid/i)).toBeInTheDocument(),
    );
  });

  it("redeems with username + password (admin invite notes MFA is next)", async () => {
    mockApi.mockResolvedValueOnce(
      json({ email: "a@b.com", role: "admin", valid: true }),
    ); // GET invite
    mockApi.mockResolvedValueOnce(json({ user: { username: "newuser" } })); // POST redeem
    render(<InviteeOnboardingPage />);
    await waitFor(() =>
      expect(screen.getByText(/You're invited/i)).toBeInTheDocument(),
    );
    // Admin invite warns that MFA comes next.
    expect(screen.getByText(/two-factor authentication/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Choose a username/i), {
      target: { value: "newuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Minimum 12/i), {
      target: { value: "Password12345" },
    });
    fireEvent.click(screen.getByText("Finish setup"));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/auth/invite/tok123/redeem",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});