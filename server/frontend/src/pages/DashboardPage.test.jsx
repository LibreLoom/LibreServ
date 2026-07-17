import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/test-utils";

const mockStorage = {};
const mockLocalStorage = {
  getItem: vi.fn((key) => mockStorage[key] ?? null),
  setItem: vi.fn((key, val) => { mockStorage[key] = String(val); }),
  removeItem: vi.fn((key) => { delete mockStorage[key]; }),
  clear: vi.fn(() => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }),
  get length() { return Object.keys(mockStorage).length; },
  key: vi.fn((i) => Object.keys(mockStorage)[i] ?? null),
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

vi.mock("../assets/greetings", () => ({
  dashboard: ["Stay productive!"],
}));

vi.mock("../hooks/useUser", () => ({
  useUser: vi.fn(),
}));

vi.mock("../hooks/useUptime", () => ({
  useUptime: vi.fn(),
}));

vi.mock("../hooks/useMonitoring", () => ({
  useMonitoring: vi.fn(),
}));

vi.mock("../hooks/useSystemHealthCheck", () => ({
  useSystemHealthCheck: vi.fn(),
}));

vi.mock("../components/dashboard/UptimeCard", () => ({
  default: ({ value }) => <div data-testid="uptime-card"><span>{value}</span></div>,
}));

vi.mock("../components/cards/HeaderCard", () => ({
  default: ({ title, leftContent, rightContent }) => (
    <div data-testid="header-card">
      <div data-testid="header-title">{title}</div>
      <div data-testid="header-left">{leftContent}</div>
      <div data-testid="header-right">{rightContent}</div>
    </div>
  ),
}));

vi.mock("../components/dashboard/AppCards", () => ({
  default: () => <div data-testid="app-cards">App Cards</div>,
}));

vi.mock("../components/dashboard/StressIndexCard", () => ({
  default: ({ value }) => <div data-testid="stress-index-card"><span>{value}</span></div>,
}));

vi.mock("../components/common/CriticalIssues", () => ({
  default: () => <div data-testid="critical-issues">Critical Issues</div>,
}));

vi.mock("../components/onboarding/InstallFirstAppCard", () => ({
  default: () => <div data-testid="install-first-app-card">Install First App</div>,
}));

import { useUser } from "../hooks/useUser";
import { useUptime } from "../hooks/useUptime";
import { useMonitoring } from "../hooks/useMonitoring";
import { useSystemHealthCheck } from "../hooks/useSystemHealthCheck";
import Dashboard from "./DashboardPage";

function clearMockStorage() {
  Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockStorage();
    vi.mocked(useUser).mockReturnValue(/** @type {any} */({ data: { username: "testuser" } }));
    vi.mocked(useUptime).mockReturnValue(/** @type {any} */({ data: 3600 }));
    vi.mocked(useMonitoring).mockReturnValue(/** @type {any} */({ data: { cpu: 0.5, ram: 0.3, disk: 0.2, net: 0.1 } }));
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({ data: null, isLoading: false, error: null }));
  });

  it("renders the dashboard title", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("header-card")).toBeInTheDocument();
  });

  it("shows the install-first-app card", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("install-first-app-card")).toBeInTheDocument();
  });

  it("shows uptime and stress index cards", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("uptime-card")).toBeInTheDocument();
    expect(screen.getByTestId("stress-index-card")).toBeInTheDocument();
  });

  it("shows app cards section", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("app-cards")).toBeInTheDocument();
  });

  it("shows critical issues in the header right content", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("critical-issues")).toBeInTheDocument();
  });

  it("renders with loading state when no resources", () => {
    vi.mocked(useMonitoring).mockReturnValue(/** @type {any} */({ data: null }));
    renderWithProviders(<Dashboard />);
    const stressCard = screen.getByTestId("stress-index-card");
    expect(stressCard.textContent).toContain("Loading...");
  });
});
