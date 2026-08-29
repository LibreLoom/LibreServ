import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../test/test-utils";
import SystemUpdatesCard from "./SystemUpdatesCard";

let pendingResolve;
const mockRequest = vi.fn();

vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({ request: mockRequest }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
    toasts: [],
  }),
}));

describe("SystemUpdatesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingResolve = null;
    mockRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolve = resolve;
        }),
    );
  });

  it("uses the Button comet spinner while checking for updates", async () => {
    renderWithProviders(<SystemUpdatesCard />);

    const button = await screen.findByRole("button", { name: /Checking/i });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector('[data-slot="spinner"]')).toBeTruthy();
    expect(button.querySelectorAll(".comet-spinner__dot")).toHaveLength(8);
    expect(button.querySelector(".animate-spin")).toBeNull();

    pendingResolve({
      ok: true,
      json: () =>
        Promise.resolve({
          current_version: "1.0.0",
          update_available: false,
        }),
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Check for Updates/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Check for Updates/i })).not.toHaveAttribute(
      "aria-busy",
    );
  });
});
