import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { mockRequest, mockAddToast } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ request: mockRequest }),
}));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

import ApiTokensCard from "./ApiTokensCard";

function mockGet(tokens) {
  mockRequest.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ tokens }),
  });
}
function mockCreate(token, apiToken) {
  mockRequest.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ token, api_token: apiToken, message: "Copy this token now." }),
  });
}
function mockDelete() {
  mockRequest.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message: "API token revoked" }),
  });
}

describe("ApiTokensCard", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("lists the user's existing tokens", async () => {
    mockGet([
      {
        id: "t1",
        name: "Backup script",
        token_prefix: "lsat_abcd1234",
        created_at: "2024-01-01T00:00:00Z",
        last_used_at: null,
      },
    ]);
    render(<ApiTokensCard />);
    await waitFor(() => expect(screen.getByText("Backup script")).toBeTruthy());
    expect(screen.getByText("lsat_abcd1234")).toBeTruthy();
  });

  it("shows the plaintext token exactly once after creating", async () => {
    mockGet([]);
    mockCreate("lsat_secretvalue", {
      id: "t2",
      name: "New token",
      token_prefix: "lsat_newp1234",
      created_at: "2024-06-26T00:00:00Z",
      last_used_at: null,
    });
    render(<ApiTokensCard />);
    await waitFor(() =>
      expect(screen.getByText(/created any API tokens/i)).toBeTruthy(),
    );
    fireEvent.change(screen.getByPlaceholderText(/token name/i), {
      target: { value: "New token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(screen.getByText("lsat_secretvalue")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("New token")).toBeTruthy());
  });

  it("revokes a token via DELETE and removes it from the list", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockGet([
      {
        id: "t1",
        name: "Backup",
        token_prefix: "lsat_abcd1234",
        created_at: "2024-01-01T00:00:00Z",
        last_used_at: null,
      },
    ]);
    mockDelete();
    render(<ApiTokensCard />);
    await waitFor(() => expect(screen.getByText("Backup")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /revoke token backup/i }));
    await waitFor(() => expect(screen.queryByText("Backup")).toBeNull());
    expect(mockRequest).toHaveBeenCalledWith("/api-tokens/t1", { method: "DELETE" });
    confirmSpy.mockRestore();
  });

  it("shows an empty state when there are no tokens", async () => {
    mockGet([]);
    render(<ApiTokensCard />);
    await waitFor(() =>
      expect(screen.getByText(/created any API tokens/i)).toBeTruthy(),
    );
  });
});