import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/test-utils";
import SettingsPage from "./SettingsPage";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light",
    toggleTheme: vi.fn(),
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
}));

vi.mock("../lib/security-api.js", () => ({
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
  sendTestNotification: vi.fn(),
}));

vi.mock("goey-toast", () => ({
  goeyToast: { success: vi.fn(), error: vi.fn() },
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

vi.mock("./LoadingFast", () => ({
  default: ({ label }) => <div data-testid="loading">{label}</div>,
}));

import { getSettings } from "../lib/settings-api.js";
import { getSecuritySettings } from "../lib/security-api.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
  it("shows loading state initially", () => {
    getSettings.mockReturnValue(new Promise(() => {}));
    getSecuritySettings.mockReturnValue(new Promise(() => {}));

    renderWithProviders(<SettingsPage />);
    expect(screen.getByTestId("loading")).toBeInTheDocument();
    expect(screen.getByText("Loading settings")).toBeInTheDocument();
  });

  it("renders settings content after loading", async () => {
    getSettings.mockResolvedValue({ logging: { level: "info" } });
    getSecuritySettings.mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-content")).toBeInTheDocument();
    });
  });

  it("shows error when loading fails", async () => {
    getSettings.mockRejectedValue(new Error("Network error"));
    getSecuritySettings.mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("renders sidebar navigation", async () => {
    getSettings.mockResolvedValue({});
    getSecuritySettings.mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      const sidebars = screen.getAllByTestId("settings-sidebar");
      expect(sidebars.length).toBe(2); // desktop + mobile
    });
  });

  it("renders mobile back button when content shown", async () => {
    getSettings.mockResolvedValue({});
    getSecuritySettings.mockResolvedValue({});

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });
});
