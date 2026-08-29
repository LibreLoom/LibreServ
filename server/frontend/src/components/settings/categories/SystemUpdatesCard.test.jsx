import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/test-utils";
import SystemUpdatesCard from "./SystemUpdatesCard";

const upToDate = {
  ok: true,
  json: () =>
    Promise.resolve({
      current_version: "1.0.0",
      update_available: false,
    }),
};

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
    mockRequest.mockResolvedValue(upToDate);
  });

  it("uses the Button comet spinner while checking for updates", async () => {
    const user = userEvent.setup();
    let resolveCheck;
    renderWithProviders(<SystemUpdatesCard />);

    const idle = await screen.findByRole("button", { name: /Check for Updates/i });
    expect(idle.querySelector('[data-slot="spinner"]')).toBeNull();

    mockRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    await user.click(idle);

    const busy = await screen.findByRole("button", { name: /Checking/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelector('[data-slot="spinner"]')).toBeTruthy();
    expect(busy.querySelectorAll(".comet-spinner__dot")).toHaveLength(8);
    expect(busy.querySelector(".animate-spin")).toBeNull();

    resolveCheck(upToDate);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Check for Updates/i })).not.toHaveAttribute(
        "aria-busy",
      );
    });
  });
});
