import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/test-utils";
import SettingsPage from "./SettingsPage";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "system",
    setTheme: vi.fn(),
    resolvedTheme: "light",
    colors: {},
    setColors: vi.fn(),
    darkColors: {},
    setDarkColors: vi.fn(),
    useSeparateDarkColors: false,
    setUseSeparateDarkColors: vi.fn(),
    resetColors: vi.fn(),
    isCustomTheme: false,
  }),
}));

vi.mock("../lib/settings-api.js", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAISettings: vi.fn(),
  updateAISettings: vi.fn(),
}));

vi.mock("../lib/security-api.js", () => ({
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
  sendTestNotification: vi.fn(),
}));

vi.mock("../lib/notifications-api.js", () => ({
  getNotifications: vi.fn(),
  updateNotifications: vi.fn(),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
    toasts: [],
  }),
}));

vi.mock("../components/settings/SettingsSidebar", () => ({
  default: ({ onCategoryChange }) => (
    <nav data-testid="settings-sidebar">
      <button onClick={() => onCategoryChange("general")}>General</button>
      <button onClick={() => onCategoryChange("security")}>Security</button>
    </nav>
  ),
}));

vi.mock("../components/settings/SettingsContent", () => ({
  default: ({ category }) => (
    <div data-testid="settings-content">{category}</div>
  ),
}));

import { getSettings } from "../lib/settings-api.js";
import { getSecuritySettings } from "../lib/security-api.js";
import { getNotifications } from "../lib/notifications-api.js";

beforeEach(() => {
  vi.clearAllMocks();
  /** @type {any} */ (getNotifications).mockResolvedValue({});
});

describe("SettingsPage", () => {
  it("renders settings immediately without loading state", async () => {
    /** @type {any} */ (getSettings).mockResolvedValue({ logging: { level: "info" } });
    /** @type {any} */ (getSecuritySettings).mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-content")).toBeInTheDocument();
    });
  });

  it("shows error when loading fails", async () => {
    /** @type {any} */ (getSettings).mockRejectedValue(new Error("Network error"));
    /** @type {any} */ (getSecuritySettings).mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("renders sidebar navigation", async () => {
    /** @type {any} */ (getSettings).mockResolvedValue({});
    /** @type {any} */ (getSecuritySettings).mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });
});
