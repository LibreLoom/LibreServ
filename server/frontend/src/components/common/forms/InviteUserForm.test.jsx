import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { mockRequest, mockAddToast } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockAddToast: vi.fn(),
}));
vi.mock("../../../hooks/useAuth", () => ({ useAuth: () => ({ request: mockRequest }) }));
vi.mock("../../../context/ToastContext", () => ({ useToast: () => ({ addToast: mockAddToast }) }));

import InviteUserForm from "./InviteUserForm";

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

describe("InviteUserForm", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockAddToast.mockReset();
  });

  it("sends an invitation with the email + role", async () => {
    mockRequest.mockResolvedValueOnce(
      json({ id: "i1", email: "a@b.com", role: "user", expires_at: "x" }),
    );
    render(<InviteUserForm />);
    fireEvent.change(screen.getByPlaceholderText(/john@example.com/i), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByText("Send Invitation"));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(
        "/users/invites",
        expect.objectContaining({
          method: "POST",
          body: expect.stringMatching(/"email":"a@b\.com"/),
        }),
      ),
    );
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
  });

  it("surfaces a plain-language error when SMTP isn't configured (400)", async () => {
    const err = Object.assign(new Error("Email isn't set up on this server"), {
      cause: { status: 400 },
    });
    mockRequest.mockRejectedValueOnce(err);
    render(<InviteUserForm />);
    fireEvent.change(screen.getByPlaceholderText(/john@example.com/i), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByText("Send Invitation"));
    await waitFor(() =>
      expect(screen.getByText(/Email isn't set up/i)).toBeInTheDocument(),
    );
  });
});