import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/test-utils";
import SetupPage from "./SetupPage";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

// Stub heavy setup sub-components so the page loads without their dependencies.
vi.mock("../components/setup/ExternalServicesStep", () => ({ default: () => null }));
vi.mock("../components/setup/PreflightRemediation", () => ({ default: () => null }));
vi.mock("../components/profile/MfaCard", () => ({ MfaSetupWizard: () => null }));
vi.mock("./Login", () => ({ default: () => null }));

import api from "../lib/api";

const apiMock = /** @type {any} */ (api);

const SETUP_TOKEN_KEY = "libreserv_setup_token";

const mockStorage = {};
const mockLocalStorage = {
  getItem: vi.fn((key) => mockStorage[key] ?? null),
  setItem: vi.fn((key, val) => { mockStorage[key] = String(val); }),
  removeItem: vi.fn((key) => { delete mockStorage[key]; }),
  clear: vi.fn(() => { Object.keys(mockStorage).forEach((k) => delete mockStorage[k]); }),
  get length() { return Object.keys(mockStorage).length; },
  key: vi.fn((i) => Object.keys(mockStorage)[i] ?? null),
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

describe("SetupPage", () => {
  beforeEach(() => {
    localStorage.removeItem(SETUP_TOKEN_KEY);
    apiMock.mockReset();
  });

  it("re-prompts for the setup code when a stale token causes a 403", async () => {
    // A token left over from a previous setup session (e.g. after a DB reset
    // changed the nonce) makes the wizard skip the code entry step.
    localStorage.setItem(SETUP_TOKEN_KEY, "STALET");
    const user = userEvent.setup();

    apiMock.mockImplementation((path) => {
      if (path === "/setup/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            setup_state: { status: "pending", current_step: "welcome", step_data: {} },
            user_status: { setup_complete: false },
            progress: { current_step: "welcome", current_sub_step: "", step_data: {} },
            code_required: true,
          }),
        });
      }
      if (path === "/setup/progress") {
        const err = /** @type {any} */ (new Error("This setup step needs a setup code. Open the setup screen on the server itself, or paste the setup code from the server console."));
        err.cause = { status: 403 };
        return Promise.reject(err);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    renderWithProviders(<SetupPage />);

    // With a stale token the wizard lands on WELCOME instead of the code step.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /begin setup/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /begin setup/i }));

    // The 403 must route back to the code entry screen and clear the stale token.
    await waitFor(() => {
      expect(screen.getByText(/enter your setup code/i)).toBeInTheDocument();
    });
    expect(localStorage.getItem(SETUP_TOKEN_KEY)).toBeNull();
  });
});
