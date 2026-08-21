import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/test-utils";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../hooks/useApps", () => ({
  useApps: vi.fn(),
}));

vi.mock("../hooks/useCatalog", () => ({
  useCatalog: vi.fn(),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ request: vi.fn(), me: { id: "u1" }, initialized: true }),
}));

vi.mock("../components/cards/HeaderCard", () => ({
  default: ({ title }) => <div data-testid="header-title">{title}</div>,
}));

vi.mock("../components/cards/Card", () => ({
  default: ({ children, className }) => <div className={className} data-testid="card">{children}</div>,
}));

vi.mock("../components/common/Dropdown", () => ({
  default: ({ value, onChange, options }) => (
    <select data-testid="category-dropdown" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  ),
}));

vi.mock("../components/common/AppIcon", () => ({
  default: ({ appId }) => <div data-testid={`app-icon-${appId}`}>Icon</div>,
}));

vi.mock("../lib/sanitize", () => ({
  sanitizeURL: (url) => url,
}));

import { useApps } from "../hooks/useApps";
import { useCatalog } from "../hooks/useCatalog";
import AppsPage from "./AppsPage";

const mockCatalog = [
  { id: "nextcloud", name: "Nextcloud", description: "Cloud storage", category: "cloud" },
  { id: "searxng", name: "SearXNG", description: "Search engine", category: "search" },
];

const mockInstalled = [
  { id: "inst-1", app_id: "nextcloud", name: "My Nextcloud", status: "running", uptime_seconds: 3600, cpu_percent: 5.5, memory_usage: 256000000, availability_pct: 99.9 },
];

describe("AppsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(useCatalog).mockReturnValue(/** @type {any} */({ data: mockCatalog, isLoading: false, error: null }));
    vi.mocked(useApps).mockReturnValue(/** @type {any} */({ data: mockInstalled, isLoading: false, error: null }));
  });

  it("renders the page title", () => {
    renderWithProviders(<AppsPage />);
    expect(screen.getByTestId("header-title")).toBeInTheDocument();
  });

  it("shows search input", () => {
    renderWithProviders(<AppsPage />);
    expect(screen.getByPlaceholderText("Search apps...")).toBeInTheDocument();
  });

  it("shows installed apps at top of catalog grid", () => {
    renderWithProviders(<AppsPage />);
    // Nextcloud is installed — it should now appear in the unified grid
    // (sorted to the top), not be hidden.
    expect(screen.getByText("Nextcloud")).toBeInTheDocument();
    expect(screen.getByText("SearXNG")).toBeInTheDocument();
  });

  it("shows install button for uninstalled apps", () => {
    renderWithProviders(<AppsPage />);
    expect(screen.getByText("Install")).toBeInTheDocument();
  });

  it("shows Manage button for installed apps", () => {
    renderWithProviders(<AppsPage />);
    // Installed apps show a Manage button instead of Install
    expect(screen.getByText("Manage")).toBeInTheDocument();
  });

  it("navigates to install page on Install click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppsPage />);
    await user.click(screen.getByText("Install"));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/install/searxng");
  });

  it("filters apps by search query", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppsPage />);
    const searchInput = screen.getByPlaceholderText("Search apps...");
    await user.type(searchInput, "SearXNG");
    expect(screen.getByText("SearXNG")).toBeInTheDocument();
  });

  it("filters apps by category", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppsPage />);
    const dropdown = screen.getByTestId("category-dropdown");
    await user.selectOptions(dropdown, "search");
    expect(screen.getByText("SearXNG")).toBeInTheDocument();
  });

  it("shows empty state when no apps match search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppsPage />);
    const searchInput = screen.getByPlaceholderText("Search apps...");
    await user.type(searchInput, "xyznonexistent");
    expect(screen.getByText("No apps match your search.")).toBeInTheDocument();
  });

  it("hides the search bar when the catalog is empty", () => {
    vi.mocked(useCatalog).mockReturnValue(/** @type {any} */({ data: [], isLoading: false, error: null }));
    vi.mocked(useApps).mockReturnValue(/** @type {any} */({ data: [], isLoading: false, error: null }));
    renderWithProviders(<AppsPage />);
    expect(screen.queryByPlaceholderText("Search apps...")).not.toBeInTheDocument();
    expect(screen.getByText("No apps yet")).toBeInTheDocument();
  });

  it("keeps the search bar when a query has no matches", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppsPage />);
    const searchInput = screen.getByPlaceholderText("Search apps...");
    await user.type(searchInput, "xyznonexistent");
    expect(screen.getByPlaceholderText("Search apps...")).toBeInTheDocument();
  });

  it("shows error state when catalog fails to load", () => {
    vi.mocked(useCatalog).mockReturnValue(/** @type {any} */({ data: [], isLoading: false, error: new Error("fail") }));
    vi.mocked(useApps).mockReturnValue(/** @type {any} */({ data: [], isLoading: false, error: null }));
    renderWithProviders(<AppsPage />);
    expect(screen.getByText("Failed to load the app catalog. Please try again.")).toBeInTheDocument();
  });

  it("shows loading overlay when data is loading", () => {
    vi.mocked(useCatalog).mockReturnValue(/** @type {any} */({ data: [], isLoading: true, error: null }));
    vi.mocked(useApps).mockReturnValue(/** @type {any} */({ data: [], isLoading: true, error: null }));
    renderWithProviders(<AppsPage />);
    expect(screen.getByText("Loading apps...")).toBeInTheDocument();
  });

  it("shows manage link for installed apps", () => {
    renderWithProviders(<AppsPage />);
    const manageLinks = screen.getAllByText("Manage");
    expect(manageLinks.length).toBeGreaterThanOrEqual(1);
  });

  it("shows running status on installed apps", () => {
    renderWithProviders(<AppsPage />);
    // Installed apps get a layered pill: status label in the inset chip,
    // plus the "Installed" trailing segment.
    expect(screen.getAllByText("Running").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Installed").length).toBeGreaterThanOrEqual(1);
  });
});
