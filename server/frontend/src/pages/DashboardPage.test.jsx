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

vi.mock("../components/cards/StatCard", () => ({
  default: ({ label, value }) => <div data-testid="stat-card"><span>{label}</span><span>{value}</span></div>,
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

vi.mock("../components/cards/AppCards", () => ({
  default: () => <div data-testid="app-cards">App Cards</div>,
}));

vi.mock("../components/cards/DropdownCard", () => ({
  default: ({ title, value }) => <div data-testid="dropdown-card"><span>{title}</span><span>{value}</span></div>,
}));

vi.mock("../components/common/RefreshDropdown", () => ({
  default: () => <div data-testid="refresh-dropdown">Refresh</div>,
  REFRESH_INTERVALS: [{ value: 30000, label: "30s" }],
}));

vi.mock("../components/onboarding/WelcomeCard", () => ({
  default: () => <div data-testid="welcome-card">Welcome</div>,
}));

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import { useUser } from "../hooks/useUser";
import { useUptime } from "../hooks/useUptime";
import { useMonitoring } from "../hooks/useMonitoring";
import api from "../lib/api";
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
  });

  it("renders the dashboard title", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("header-card")).toBeInTheDocument();
  });

  it("shows the welcome card", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("welcome-card")).toBeInTheDocument();
  });

  it("shows stat cards with uptime and stress index", () => {
    renderWithProviders(<Dashboard />);
    const statCards = screen.getAllByTestId("stat-card");
    expect(statCards.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("dropdown-card")).toBeInTheDocument();
  });

  it("shows app cards section", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("app-cards")).toBeInTheDocument();
  });

  it("shows refresh dropdown", () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId("refresh-dropdown")).toBeInTheDocument();
  });

  it("renders with loading state when no resources", () => {
    vi.mocked(useMonitoring).mockReturnValue(/** @type {any} */({ data: null }));
    renderWithProviders(<Dashboard />);
    const dropdownCard = screen.getByTestId("dropdown-card");
    expect(dropdownCard.textContent).toContain("Loading...");
  });

  it("renders system status badge", async () => {
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText("Checking...")).toBeInTheDocument();
  });

  it("shows repo status when data available", async () => {
    vi.mocked(api).mockResolvedValue(/** @type {any} */({
      ok: true,
      json: () => Promise.resolve([{ last_pull: "2024-01-15T10:30:00Z" }]),
    }));
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/App repository/)).toBeInTheDocument();
  });
});
