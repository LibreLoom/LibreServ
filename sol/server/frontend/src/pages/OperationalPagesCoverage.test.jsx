import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actions: [],
  actionsLoading: false,
  addToast: vi.fn(),
  api: vi.fn(),
  app: null,
  appError: null,
  appLoading: false,
  availableUpdate: null,
  catalogFeatures: null,
  connectStatus: vi.fn(),
  invalidateApps: vi.fn(),
  locationSearch: "",
  metrics: null,
  navigate: vi.fn(),
  networkReport: vi.fn(),
  params: { instanceId: "instance-1" },
  queryClient: {
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  },
  request: vi.fn(),
  showLoading: false,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const original = /** @type {Record<string, any>} */ (await importOriginal());
  return {
    ...original,
    Link: ({ children, to, ...props }) => (
      <a href={typeof to === "string" ? to : "#"} {...props}>
        {children}
      </a>
    ),
    useNavigate: () => testState.navigate,
    useParams: () => testState.params,
    useSearchParams: () => [new URLSearchParams(testState.locationSearch)],
  };
});
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = /** @type {Record<string, any>} */ (await importOriginal());
  return {
    ...original,
    useQueryClient: () => testState.queryClient,
  };
});

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ request: testState.request }),
}));
vi.mock("../hooks/useApps", () => ({
  useInvalidateApps: () => testState.invalidateApps,
}));
vi.mock("../hooks/useAppDetail", () => ({
  useAppDetail: () => ({
    data: testState.app,
    error: testState.appError,
    isLoading: testState.appLoading,
  }),
}));
vi.mock("../hooks/useAppMetrics", () => ({
  useAppMetrics: () => ({ data: testState.metrics }),
}));
vi.mock("../hooks/useAppUpdates", () => ({
  useAppUpdates: () => ({ data: testState.availableUpdate }),
}));
vi.mock("../hooks/useAppActions", () => ({
  useAppActions: () => ({
    data: testState.actions,
    isLoading: testState.actionsLoading,
  }),
}));
vi.mock("../hooks/useDelayedLoading", () => ({
  useDelayedLoading: () => testState.showLoading,
}));
vi.mock("../hooks/useCatalogFeatures", () => ({
  useCatalogFeatures: () => ({ data: testState.catalogFeatures }),
}));
vi.mock("../hooks/useTimeFormat", () => ({
  useTimeFormat: () => ({
    formatDateTime: (value) => `formatted:${value}`,
  }),
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ addToast: testState.addToast }),
}));
vi.mock("../lib/api", () => ({ default: testState.api }));
vi.mock("../lib/network-api", () => ({
  getNetworkReport: testState.networkReport,
}));
vi.mock("../lib/connect-api", () => ({
  getConnectStatus: testState.connectStatus,
}));

vi.mock("../components/ui/Page", () => ({
  default: ({ children, leftContent, rightContent, title }) => (
    <main>
      <header>
        {leftContent}
        <h1>{title}</h1>
        {rightContent}
      </header>
      {children}
    </main>
  ),
}));
vi.mock("../components/cards/Card", () => ({
  default: ({ children }) => <section>{children}</section>,
}));
vi.mock("../components/cards/HeaderCard", () => ({
  default: ({ title }) => <header>{title}</header>,
}));
vi.mock("../components/cards/MetricCard", () => ({
  default: ({ children, label, value }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
      {children}
    </div>
  ),
}));
vi.mock("../components/ui/Button", () => ({
  default: ({
    asChild,
    children,
    disabled,
    loading,
    onClick,
    type = "button",
  }) =>
    asChild ? (
      children
    ) : (
      <button
        type={/** @type {"button" | "reset" | "submit"} */ (type)}
        disabled={disabled || loading}
        onClick={onClick}
      >
        {children}
      </button>
    ),
}));
vi.mock("../components/cards/ModalCard", () => ({
  default: ({ children, onClose, title }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {typeof children === "function" ? children({ close: onClose }) : children}
    </div>
  ),
}));
vi.mock("../components/cards/StateOverlay", () => ({
  default: ({ children, message }) => <div>{message || children}</div>,
}));
vi.mock("../components/common/AppIcon", () => ({
  default: ({ appId }) => <span>icon:{appId}</span>,
}));
vi.mock("../components/common/StatusPill", () => ({
  default: ({ status }) => <span>status:{status}</span>,
}));
vi.mock("../components/common/SegmentedControl", () => ({
  default: ({ onChange, options }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/app/actions/ActionCard", () => ({
  ActionCard: ({ action, disabled, onExecute }) => (
    <button type="button" disabled={disabled} onClick={onExecute}>
      Run {action.label}
    </button>
  ),
}));
vi.mock("../components/app/actions/ActionOptionsModal", () => ({
  ActionOptionsModal: ({ action, onClose, onExecute }) => (
    <div role="dialog" aria-label={`${action.label} options`}>
      <button type="button" onClick={() => onExecute(action.name, { force: true })}>
        Execute action
      </button>
      <button type="button" onClick={onClose}>
        Close action
      </button>
    </div>
  ),
}));
vi.mock("../components/app/ExposedInfoCard", () => ({
  ExposedInfoCard: ({ info }) => <div>exposed:{Object.keys(info).join(",")}</div>,
}));
vi.mock("../components/app/AccessControlSection", () => ({
  default: ({ accessModel }) => <div>access:{accessModel}</div>,
}));
vi.mock("../components/app/LogsViewer", () => ({
  default: ({ onClose }) => (
    <div role="dialog" aria-label="Logs">
      App logs
      <button type="button" onClick={onClose}>
        Close logs
      </button>
    </div>
  ),
}));
vi.mock("../components/app/RevocationBanner", () => ({
  default: ({ onSeeDetails }) => (
    <button type="button" onClick={onSeeDetails}>
      Review revocation
    </button>
  ),
}));
vi.mock("../components/app/AcknowledgeRevocationModal", () => ({
  default: ({ onAcknowledged, onClose }) => (
    <div role="dialog" aria-label="Revocation">
      <button type="button" onClick={onAcknowledged}>
        Acknowledge
      </button>
      <button type="button" onClick={onClose}>
        Close revocation
      </button>
    </div>
  ),
}));
vi.mock("../components/app/ReconfigureModal", () => ({
  default: ({ app, onClose, onSuccess }) => (
    <div role="dialog" aria-label="Reconfigure">
      <button
        type="button"
        onClick={() => onSuccess({ ...app, name: "Updated Notes" })}
      >
        Save settings
      </button>
      <button type="button" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
}));
vi.mock("./ObjectNotFound", () => ({
  default: ({ objectName }) => <div>Missing app: {objectName}</div>,
}));

vi.mock("../components/common/PageNotice", () => ({
  default: ({ children }) => <aside>{children}</aside>,
}));
vi.mock("../components/settings/SettingsCard", () => ({
  default: ({ children, headerActions, title }) => (
    <section>
      <h2>{title}</h2>
      {headerActions}
      {children}
    </section>
  ),
}));
vi.mock("../components/settings/SettingsRow", () => ({
  default: ({ children, description, label }) => (
    <div>
      <span>{label}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
}));
vi.mock("../components/common/CollapsibleSection", () => ({
  default: ({ children, title }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));
vi.mock("../components/cards/ConfirmModal", () => ({
  default: ({ confirmLabel = "Confirm", onClose, onConfirm, open, title }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import AppDetailPage from "./AppDetailPage";
import TroubleshootPage from "./TroubleshootPage";

const response = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
});

const installedApp = {
  app_id: "notes",
  backends: [],
  exposed_info: { username: "ada" },
  health_status: "healthy",
  id: "instance-1",
  installed_at: "2026-08-01T12:00:00Z",
  name: "Notes",
  revocation_notice: { reason: "Signing key changed" },
  status: "running",
  url: "https://notes.example.test",
};

function renderWithQuery(ui) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  testState.actions = [];
  testState.actionsLoading = false;
  testState.addToast.mockReset();
  testState.api.mockReset();
  testState.app = null;
  testState.appError = null;
  testState.appLoading = false;
  testState.availableUpdate = null;
  testState.catalogFeatures = null;
  testState.connectStatus.mockReset();
  testState.invalidateApps.mockReset();
  testState.locationSearch = "";
  testState.metrics = null;
  testState.navigate.mockReset();
  testState.networkReport.mockReset();
  testState.params = { instanceId: "instance-1" };
  testState.queryClient.invalidateQueries.mockReset();
  testState.queryClient.invalidateQueries.mockResolvedValue(undefined);
  testState.queryClient.setQueryData.mockReset();
  testState.request.mockReset();
  testState.request.mockResolvedValue(response({ completed: true }));
  testState.showLoading = false;
});

describe("AppDetailPage", () => {
  it("renders operational data and completes app actions", async () => {
    const user = userEvent.setup();
    testState.app = installedApp;
    testState.metrics = {
      cpu_percent: 12.34,
      memory_limit: 2 * 1024 * 1024,
      memory_usage: 1024 * 1024,
      network_rx: 0,
      network_tx: 2048,
    };
    testState.availableUpdate = {
      compose_template_changed: true,
      current_version: "1.0",
      digest_tracking_enabled: false,
      latest_version: "1.1",
      needs_config: false,
    };
    testState.actions = [
      { name: "backup", label: "Backup" },
      { name: "view-logs", label: "Logs" },
    ];
    testState.catalogFeatures = { access_model: "per_user" };

    render(<AppDetailPage />);

    expect(screen.getByText("12.3%")).toBeVisible();
    expect(screen.getByText("1 MB / 2 MB")).toBeVisible();
    expect(screen.getByText("access:per_user")).toBeVisible();
    expect(screen.getByText("exposed:username")).toBeVisible();
    expect(screen.getByText("Update Available")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(testState.request).toHaveBeenCalledWith(
        "/apps/instance-1/stop",
        { method: "POST" },
      ),
    );
    expect(testState.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["apps", "instance-1"],
    });

    await user.click(screen.getByRole("button", { name: "View Logs" }));
    expect(screen.getByRole("dialog", { name: "Logs" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close logs" }));

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(testState.queryClient.setQueryData).toHaveBeenCalledWith(
      ["apps", "instance-1"],
      expect.objectContaining({ name: "Updated Notes" }),
    );
    expect(testState.invalidateApps).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run Backup" }));
    await user.click(screen.getByRole("button", { name: "Execute action" }));
    await waitFor(() =>
      expect(testState.request).toHaveBeenCalledWith(
        "/apps/instance-1/actions/backup/execute",
        expect.objectContaining({
          body: JSON.stringify({
            action: "backup",
            options: { force: true },
          }),
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Review revocation" }));
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(testState.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["apps", "instance-1"],
    });

    await user.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = screen.getByRole("dialog", { name: "Uninstall Application" });
    await user.type(
      within(dialog).getByPlaceholderText('Type "Notes"'),
      "Notes",
    );
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() =>
      expect(testState.navigate).toHaveBeenCalledWith("/apps"),
    );
    expect(testState.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Notes was uninstalled" }),
    );
  });

  it("opens logs directly from a catalog action", async () => {
    const user = userEvent.setup();
    testState.app = { ...installedApp, revocation_notice: null };
    testState.actions = [{ name: "view-logs", label: "Diagnostic logs" }];
    render(<AppDetailPage />);

    await user.click(
      screen.getByRole("button", { name: "Run Diagnostic logs" }),
    );
    expect(screen.getByRole("dialog", { name: "Logs" })).toBeVisible();
  });

  it("renders loading, failure, and missing-app states", () => {
    testState.appLoading = true;
    testState.showLoading = true;
    const { unmount } = render(<AppDetailPage />);
    expect(screen.getByText("Loading app...")).toBeVisible();
    unmount();

    testState.appLoading = false;
    testState.appError = new Error("App service unavailable");
    const failed = render(<AppDetailPage />);
    expect(screen.getByText("Error: App service unavailable")).toBeVisible();
    failed.unmount();

    const missing = /** @type {any} */ (new Error("not found"));
    missing.cause = { status: 404 };
    testState.appError = missing;
    render(<AppDetailPage />);
    expect(screen.getByText("Missing app: instance-1")).toBeVisible();
  });

  it("renders stopped and unhealthy values safely", () => {
    testState.app = {
      ...installedApp,
      health_status: "unhealthy",
      installed_at: null,
      status: "stopped",
      url: "",
    };
    testState.metrics = {
      cpu_percent: null,
      memory_limit: 0,
      memory_usage: 0,
    };
    testState.availableUpdate = {
      current_version: "1.0",
      latest_version: "2.0",
      needs_config: true,
      needs_config_reason: "Choose a storage folder",
    };
    testState.actions = [{ name: "backup", label: "Backup" }];
    testState.actionsLoading = true;

    render(<AppDetailPage />);
    expect(screen.getByText("N/A")).toBeVisible();
    expect(screen.getAllByText("0 B / 0 B")).toHaveLength(2);
    expect(screen.getByText("Setup Required")).toBeVisible();
    expect(screen.getByText(/Choose a storage folder/)).toBeVisible();
  });
});

describe("TroubleshootPage", () => {
  it("summarizes successful checks and exposes recovery steps", async () => {
    const user = userEvent.setup();
    testState.locationSearch = "issue=connect-key";
    testState.api.mockImplementation(async (path) => {
      if (path === "/system/health/check") {
        return response({
          checks: {
            api_server: { status: "passed" },
            database: { status: "passed" },
            disk_space: { status: "passed", message: "20 GB free" },
            runtime: { status: "passed" },
            smtp: { status: "passed", details: { optional: false } },
          },
        });
      }
      return response({ proxy: { default_domain: "home.example.test" } });
    });
    testState.networkReport.mockResolvedValue({
      connect: { active: true, tunnel_ok: true },
      headline: "Internet access is working.",
      stacks: {},
    });
    testState.connectStatus.mockResolvedValue({ connected: true });

    renderWithQuery(<TroubleshootPage />);

    expect(
      await screen.findByText("The LibreServ software is running normally."),
    ).toBeVisible();
    expect(screen.getByText("Internet access is working.")).toBeVisible();
    expect(screen.getByText("20 GB free")).toBeVisible();
    expect(screen.getByText(/home.example.test/)).toBeVisible();
    expect(screen.getByText("LibreServ Connect is connected.")).toBeVisible();
    expect(screen.getByText(/Connect key didn't work/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Re-run checks/ }));
    await waitFor(() =>
      expect(testState.networkReport).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Restart now/ }));
    const dialog = screen.getByRole("dialog", { name: "Restart LibreServ?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Restart LibreServ?" }),
    ).not.toBeInTheDocument();
  });

  it("keeps troubleshooting usable when all diagnostics fail", async () => {
    testState.api.mockRejectedValue(new Error("offline"));
    testState.networkReport.mockRejectedValue(new Error("offline"));
    testState.connectStatus.mockRejectedValue(new Error("offline"));

    renderWithQuery(<TroubleshootPage />);

    expect(
      await screen.findByText("Couldn't check your internet connection right now."),
    ).toBeVisible();
    expect(screen.getByText("Couldn't check email sending.")).toBeVisible();
    expect(screen.getByText("Couldn't check storage space.")).toBeVisible();
    expect(screen.getByText("Couldn't check LibreServ Connect.")).toBeVisible();
  });
});
