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

vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
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
    /** @type {(value: any) => void} */
    let resolveCheck = () => {};
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

  it("shows the saved update channel and saves a change", async () => {
    const user = userEvent.setup();
    mockRequest.mockImplementation((path, options) => {
      if (path === "/settings" && !options) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { channel: "beta" } }) });
      }
      return Promise.resolve(upToDate);
    });
    renderWithProviders(<SystemUpdatesCard />);

    expect(screen.getByText("Update channel")).toBeInTheDocument();
    expect(screen.getByText(/Beta gets new versions first/)).toBeInTheDocument();
    const beta = await screen.findByRole("radio", { name: "Beta" });
    await waitFor(() => expect(beta).toBeChecked());

    await user.click(screen.getByRole("radio", { name: "Stable" }));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ updates: { channel: "stable" } }),
        }),
      );
    });
    expect(screen.getByRole("radio", { name: "Stable" })).toBeChecked();
  });

  it("goes back to the old channel when saving fails", async () => {
    const user = userEvent.setup();
    mockRequest.mockImplementation((path, options) => {
      if (path === "/settings" && options?.method === "PUT") {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      return Promise.resolve(upToDate);
    });
    renderWithProviders(<SystemUpdatesCard />);

    await user.click(await screen.findByRole("radio", { name: "Beta" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Stable" })).toBeChecked());
  });

  it("offers release notes in the app, not a link to a release page", async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          current_version: "1.0.0",
          latest_version: "2.0.0",
          update_available: true,
          release_notes: "Fixes",
        }),
    });
    renderWithProviders(<SystemUpdatesCard />);

    expect(await screen.findByRole("button", { name: /See what's new in 2.0.0/ })).toBeInTheDocument();
    expect(document.querySelector("a[href]")).toBeNull();
  });
});
