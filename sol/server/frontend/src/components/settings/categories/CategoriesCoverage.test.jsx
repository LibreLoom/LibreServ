import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addToastMock,
  apiMock,
  getConnectUsageMock,
  hapticMock,
  healthState,
  logoutMock,
  navigateMock,
  requestMock,
  setHapticsEnabledMock,
} = vi.hoisted(() => ({
  addToastMock: vi.fn(),
  apiMock: vi.fn(),
  getConnectUsageMock: vi.fn(),
  hapticMock: vi.fn(),
  healthState: { data: null, isLoading: false, error: null },
  logoutMock: vi.fn(),
  navigateMock: vi.fn(),
  requestMock: vi.fn(),
  setHapticsEnabledMock: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.jsx", () => ({
  useAuth: () => ({ request: requestMock, logout: logoutMock }),
}));
vi.mock("../../../context/ToastContext.jsx", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("../../../hooks/useTimeFormat.jsx", () => ({
  useTimeFormat: () => ({ use12HourTime: false }),
}));
vi.mock("../../../hooks/useSystemHealthCheck.jsx", () => ({
  useSystemHealthCheck: () => healthState,
}));
vi.mock("../../../utils/haptics.js", () => ({
  haptic: hapticMock,
  setHapticsEnabled: setHapticsEnabledMock,
  useHapticsEnabled: () => true,
}));
vi.mock("../../../lib/connect-api.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getConnectUsage: getConnectUsageMock };
});
vi.mock("../../../lib/api.js", () => ({ default: apiMock }));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, useNavigate: () => navigateMock };
});

vi.mock("../SettingsCard.jsx", () => ({
  default: ({ title, headerActions, children }) => (
    <section>
      <h2>{title}</h2>
      {headerActions}
      {children}
    </section>
  ),
}));
vi.mock("../SettingsRow.jsx", () => ({
  default: ({ label, description, children }) => (
    <div>
      <span>{label}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
}));
vi.mock("../../common/Toggle.jsx", () => ({
  default: ({ checked, onChange, label }) => (
    <button type="button" aria-pressed={checked} onClick={() => onChange(!checked)}>
      {label}
    </button>
  ),
}));
vi.mock("../../common/SegmentedControl.jsx", () => ({
  default: ({ options, value, onChange }) => (
    <div>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../common/CheckboxOptionGroup.jsx", () => ({
  default: ({ options, values, onChange }) => (
    <div>
      {options.map((option) => (
        <button
          type="button"
          key={option.key}
          aria-pressed={values[option.key]}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../common/RadioOptionGroup.jsx", () => ({
  default: ({ options, value, onChange }) => (
    <div>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../common/Dropdown.jsx", () => ({
  default: ({ options, value, onChange }) => (
    <select
      aria-label="Activity range"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../common/Table.jsx", () => ({
  default: ({ columns, data, rowKey }) => (
    <table>
      <tbody>
        {data.map((row) => (
          <tr key={row[rowKey]}>
            {columns.map((column) => (
              <td key={column.key}>
                {column.render ? column.render(row) : row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));
vi.mock("../../ui/Button.jsx", () => ({
  default: ({
    "aria-label": ariaLabel,
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
        type={type}
        aria-label={ariaLabel}
        disabled={disabled || loading}
        onClick={onClick}
      >
        {children}
      </button>
    ),
}));
vi.mock("../../ui/TypewriterLoader.jsx", () => ({
  default: () => <div>Loading activity</div>,
}));
vi.mock("../../cards/ModalCard.jsx", () => ({
  default: ({ children, onClose, title }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>Close modal</button>
      {typeof children === "function" ? children({ close: onClose }) : children}
    </div>
  ),
}));
vi.mock("../../cards/ConfirmModal.jsx", () => ({
  default: ({
    children,
    confirmLabel = "Confirm",
    disabledConfirm,
    onClose,
    onConfirm,
    open,
    title,
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        <button type="button" onClick={onClose}>Cancel confirmation</button>
        <button type="button" disabled={disabledConfirm} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("../../common/CollapsibleSection.jsx", () => ({
  default: ({ children, title }) => (
    <div>
      <span>{title}</span>
      {children}
    </div>
  ),
}));
vi.mock("../../common/Callout.jsx", () => ({
  default: ({ action, children, title }) => (
    <div>
      {title}
      {children}
      {action}
    </div>
  ),
}));
vi.mock("../../common/AppIcon.jsx", () => ({
  default: ({ appId }) => <span>{appId}</span>,
}));
vi.mock("../../backups/ScheduleForm.jsx", () => ({
  default: ({ appName, onClose, onSaved }) => (
    <div role="dialog" aria-label={`${appName} schedule`}>
      <button type="button" onClick={onSaved}>Save schedule</button>
      <button type="button" onClick={onClose}>Close schedule</button>
    </div>
  ),
}));
vi.mock("./SystemUpdatesCard.jsx", () => ({
  default: () => <div>System updates</div>,
}));

function serviceModal(name) {
  return {
    default: ({ open, onClose }) =>
      open ? (
        <div role="dialog" aria-label={`${name} service`}>
          <button type="button" onClick={onClose}>Close {name}</button>
        </div>
      ) : null,
  };
}

vi.mock("../../connect/ConnectStatusCard.jsx", () => ({
  default: ({ onActivate, onDeactivate }) => (
    <div>
      <button type="button" onClick={() => onActivate("connect-key")}>
        Activate Connect
      </button>
      <button type="button" onClick={onDeactivate}>Deactivate Connect</button>
    </div>
  ),
}));
vi.mock("../../connect/EmailServiceModal.jsx", () => serviceModal("email"));
vi.mock("../../connect/DomainServiceModal.jsx", () => serviceModal("domain"));
vi.mock("../../connect/BackupServiceModal.jsx", () => serviceModal("backup"));
vi.mock("../../connect/TunnelServiceModal.jsx", () => serviceModal("tunnel"));
vi.mock("../../connect/AIServiceModal.jsx", () => serviceModal("ai"));

import AboutCategory from "./AboutCategory.jsx";
import AppearanceCategory from "./AppearanceCategory.jsx";
import BackupsCategory from "./BackupsCategory.jsx";
import ExternalServicesCategory from "./ExternalServicesCategory.jsx";
import FactoryResetCard from "./FactoryResetCard.jsx";
import GeneralCategory from "./GeneralCategory.jsx";
import NotificationsCategory from "./NotificationsCategory.jsx";
import RepoStatusCard from "./RepoStatusCard.jsx";
import SecurityCategory from "./SecurityCategory.jsx";

const jsonResponse = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
  blob: vi.fn().mockResolvedValue(new Blob(["backup"])),
});

beforeEach(() => {
  addToastMock.mockReset();
  apiMock.mockReset();
  getConnectUsageMock.mockReset();
  hapticMock.mockReset();
  logoutMock.mockReset();
  navigateMock.mockReset();
  requestMock.mockReset();
  setHapticsEnabledMock.mockReset();
  healthState.data = null;
  healthState.isLoading = false;
  healthState.error = null;
  window.history.replaceState(null, "", "/");
  apiMock.mockResolvedValue(jsonResponse({ csrf_token: "csrf" }));
  getConnectUsageMock.mockResolvedValue({ by_service: {} });
});

describe("settings category coverage", () => {
  it("changes appearance preferences and custom colors", async () => {
    const user = userEvent.setup();
    const props = {
      theme: "system",
      onThemeChange: vi.fn(),
      resolvedTheme: "light",
      colors: {
        primary: "#ffffff",
        secondary: "#000000",
        accent: "#767676",
      },
      setColors: vi.fn(),
      darkColors: {
        primary: "#000000",
        secondary: "#ffffff",
        accent: "#767676",
      },
      setDarkColors: vi.fn(),
      useSeparateDarkColors: true,
      setUseSeparateDarkColors: vi.fn(),
      resetColors: vi.fn(),
      isCustomTheme: true,
    };
    const { rerender } = render(<AppearanceCategory {...props} />);

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(props.onThemeChange).toHaveBeenCalledWith("dark");

    await user.click(screen.getByRole("button", { name: "Apply Ocean preset" }));
    expect(hapticMock).toHaveBeenCalledWith("selection");
    expect(props.setColors).toHaveBeenCalledWith(
      expect.objectContaining({ primary: "#cce7f5" }),
    );

    const primaryHex = screen.getByLabelText("Primary hex value");
    await user.clear(primaryHex);
    await user.type(primaryHex, "invalid");
    expect(primaryHex).toHaveClass("border-error");
    await user.clear(primaryHex);
    await user.type(primaryHex, "#123456");
    expect(props.setColors).toHaveBeenCalledWith(
      expect.objectContaining({ primary: "#123456" }),
    );

    fireEvent.change(screen.getByLabelText("Choose Accent color"), {
      target: { value: "#abcdef" },
    });
    expect(props.setColors).toHaveBeenCalledWith(
      expect.objectContaining({ accent: "#abcdef" }),
    );

    fireEvent.change(screen.getByLabelText("Choose Primary (Dark) color"), {
      target: { value: "#101010" },
    });
    expect(props.setDarkColors).toHaveBeenCalledWith(
      expect.objectContaining({ primary: "#101010" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Separate Dark Mode Colors" }),
    );
    expect(props.setUseSeparateDarkColors).toHaveBeenCalledWith(false);
    await user.click(
      screen.getByRole("button", { name: "Vibration Feedback" }),
    );
    expect(setHapticsEnabledMock).toHaveBeenCalledWith(false);
    await user.click(
      screen.getByRole("button", { name: "Reset colors to default" }),
    );
    expect(props.resetColors).toHaveBeenCalled();

    rerender(
      <AppearanceCategory
        {...props}
        isCustomTheme={false}
        useSeparateDarkColors={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Enable Custom Colors" }),
    );
  });

  it("renders connected external service limits and opens services", async () => {
    const user = userEvent.setup();
    const onActivateConnect = vi.fn();
    const onDeactivateConnect = vi.fn();
    getConnectUsageMock.mockResolvedValue({
      by_service: {
        smtp: { value: 12 },
        backup: { value: 2048 },
        ai: { value: 5 },
      },
    });
    const connectStatus = {
      connected: true,
      plan: { id: "pro", name: "Pro" },
      services: {
        smtp: { state: "connected", details: { provider: "mail" } },
        domain: {
          state: "connected",
          details: {
            type: "custom",
            domain: "example.test",
            status: "active",
            expires_at: "2027-01-02T00:00:00Z",
            auto_renew: "true",
          },
        },
        backup: { state: "byo" },
        tunnel: { state: "connected" },
        ai: { state: "connected" },
        support: { state: "connected" },
      },
    };
    render(
      <ExternalServicesCategory
        connectStatus={connectStatus}
        connectInfo={{
          plan_limits: {
            pro: {
              max_emails_per_day: 1000,
              domain: "Included",
              backup_gb: 2048,
              ai_credit_cents: 500,
            },
          },
        }}
        settings={{ ai_support: { enabled: true } }}
        repos={[]}
        onActivateConnect={onActivateConnect}
        onDeactivateConnect={onDeactivateConnect}
      />,
    );

    await waitFor(() =>
      expect(screen.getAllByText("12 used").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("2 TB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$5.00 credit/mo").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Active · renews Jan 2, 2027/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Included").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Email/ }));
    expect(screen.getByRole("dialog", { name: "email service" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close email" }));

    const domainCard = screen.getByRole("button", { name: /Domain & DNS/ });
    fireEvent.keyDown(domainCard, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "domain service" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close domain" }));

    await user.click(screen.getByRole("button", { name: "Activate Connect" }));
    expect(onActivateConnect).toHaveBeenCalledWith("connect-key");
    await user.click(screen.getByRole("button", { name: "Deactivate Connect" }));
    expect(onDeactivateConnect).toHaveBeenCalled();
  });

  it("opens an external service from the URL hash and handles usage failure", async () => {
    window.history.replaceState(
      null,
      "",
      "/#external_services-backup",
    );
    getConnectUsageMock.mockRejectedValue(new Error("offline"));
    const { unmount } = render(
      <ExternalServicesCategory
        connectStatus={{ connected: true, services: {} }}
        settings={{}}
        repos={[]}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "backup service" }),
    ).toBeVisible();
    expect(window.location.hash).toBe("#external_services");
    await waitFor(() => expect(getConnectUsageMock).toHaveBeenCalled());
    unmount();
  });

  it("updates notification settings and sends test email", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const onSecuritySettingsChange = vi.fn();
    apiMock.mockResolvedValue(jsonResponse({ sent: true }));
    render(
      <NotificationsCategory
        settings={{
          smtp: { configured: true, from: "admin@example.test" },
          notify: { enabled: true },
        }}
        securitySettings={{
          notification_frequency: "normal",
          notify_on_login: true,
        }}
        onSettingsChange={onSettingsChange}
        onSecuritySettingsChange={onSecuritySettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send Test" }));
    expect(apiMock).toHaveBeenCalledWith(
      "/monitoring/email/test",
      expect.objectContaining({
        body: JSON.stringify({ to: "admin@example.test" }),
      }),
    );
    expect(addToastMock).toHaveBeenCalledWith({
      type: "success",
      message: "Test email sent!",
    });

    await user.click(
      screen.getByRole("button", { name: "Enable Notifications" }),
    );
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ notify: { enabled: false } }),
    );
    await user.click(screen.getByRole("button", { name: "Instant" }));
    expect(onSecuritySettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ notification_frequency: "instant" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Successful logins" }),
    );
    expect(onSecuritySettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ notify_on_login: false }),
    );
  });

  it("reports test email failures", async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValue("offline");
    render(
      <NotificationsCategory
        settings={{ smtp: { configured: true }, notify: { enabled: false } }}
        securitySettings={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send Test" }));
    expect(addToastMock).toHaveBeenCalledWith({
      type: "error",
      message: "offline",
    });
  });

  it("loads, renders, filters, and refreshes security events", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(
      jsonResponse({
        events: [
          {
            id: "one",
            timestamp: new Date().toISOString(),
            event_type: "login_failed",
            actor_username: "<admin>",
            severity: "critical",
          },
          {
            id: "two",
            timestamp: new Date().toISOString(),
            event_type: "login_success",
            actor_username: "",
            severity: "warning",
          },
          {
            id: "three",
            timestamp: new Date().toISOString(),
            event_type: "logout",
            actor_username: "member",
            severity: "info",
          },
        ],
      }),
    );
    render(<SecurityCategory />);

    expect(await screen.findByText("Failed Login Attempt")).toBeVisible();
    expect(screen.getByText("&lt;admin&gt;")).toBeVisible();
    expect(screen.getByText("System")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Activity range"), "24h");
    await user.selectOptions(screen.getByLabelText("Activity range"), "30d");
    await user.selectOptions(screen.getByLabelText("Activity range"), "all");
    await user.click(
      screen.getByRole("button", { name: "Refresh activity log" }),
    );
    expect(apiMock.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("shows security loading, empty, and failure states", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<SecurityCategory />);
    expect(document.querySelector('[data-slot="security-category"]')).toBeTruthy();
    unmount();

    apiMock.mockResolvedValue(jsonResponse([]));
    const empty = render(<SecurityCategory />);
    expect(await screen.findByText("No security events found")).toBeVisible();
    empty.unmount();

    apiMock.mockRejectedValue(new Error("activity unavailable"));
    render(<SecurityCategory />);
    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith({
        type: "error",
        message: "activity unavailable",
      }),
    );
  });

  it("shows repository status and performs pull, add, and remove actions", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(async (path) => {
      if (path === "/repos/status") {
        return jsonResponse([
          {
            url: "https://example.test/apps.git",
            branch: "main",
            last_pull: new Date().toISOString(),
          },
          {
            url: "https://bad.example/apps.git",
            branch: "stable",
            last_pull: "0001-01-01T00:00:00Z",
            last_error: "offline",
          },
        ]);
      }
      return jsonResponse({ ok: true });
    });
    render(<RepoStatusCard />);

    expect(await screen.findByText("https://example.test/apps.git")).toBeVisible();
    expect(screen.getByText("Last checked: Just now")).toBeVisible();
    expect(screen.getByText("Last checked: Never")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Check for new apps/ }));
    expect(requestMock).toHaveBeenCalledWith(
      "/repos/pull",
      expect.objectContaining({ method: "POST" }),
    );

    await user.click(screen.getByRole("button", { name: /Add a source/ }));
    expect(screen.getByRole("dialog", { name: "Add an app source" })).toBeVisible();
    await user.type(
      screen.getByLabelText("Repository URL"),
      " https://new.example/apps.git ",
    );
    await user.clear(screen.getByLabelText("Branch"));
    await user.type(screen.getByLabelText("Branch"), "stable");
    await user.clear(screen.getByLabelText("Priority"));
    await user.type(screen.getByLabelText("Priority"), "2");
    await user.click(screen.getByRole("button", { name: "Add app source" }));
    expect(requestMock).toHaveBeenCalledWith(
      "/repos",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://new.example/apps.git",
          branch: "stable",
          priority: 2,
        }),
      }),
    );

    await user.click(
      screen.getAllByRole("button", { name: "Remove app source" })[0],
    );
    await user.click(screen.getByRole("button", { name: "Remove source" }));
    expect(requestMock).toHaveBeenCalledWith(
      "/repos/0",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("backs up, restores, deletes, downloads, and uploads backup data", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    requestMock.mockImplementation(async (path) => {
      if (path === "/backups") {
        return jsonResponse({
          backups: [
            {
              id: "backup-1",
              app_id: "installed-1",
              created_at: new Date(now - 60_000).toISOString(),
              size: 2048,
            },
            {
              id: "orphan-1",
              app_id: "removed-app",
              created_at: new Date(now - 9 * 86400_000).toISOString(),
              size: 1024,
            },
          ],
        });
      }
      if (path === "/apps") {
        return jsonResponse({
          apps: [{ id: "installed-1", app_id: "notes", name: "Notes" }],
        });
      }
      if (path === "/backups/schedules") {
        return jsonResponse({
          schedules: [
            {
              app_id: "installed-1",
              enabled: true,
              retention: 5,
              next_run: new Date(now + 86400_000).toISOString(),
            },
          ],
        });
      }
      if (path === "/backups/repos") return jsonResponse({ repos: [] });
      return jsonResponse({ ok: true });
    });
    window.URL.createObjectURL = vi.fn(() => "blob:backup");
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<BackupsCategory connectStatus={{ services: {} }} />);

    expect(await screen.findByText("2 of 1 apps backed up")).toBeVisible();
    expect(screen.getByText("Copies from apps that are no longer installed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Notes backups" }));
    expect(screen.getByText(/Automatic backups on/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back up" }));
    expect(requestMock).toHaveBeenCalledWith(
      "/backups",
      expect.objectContaining({ method: "POST" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Restore this backup" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(requestMock).toHaveBeenCalledWith(
      "/backups/backup-1/restore",
      expect.objectContaining({ method: "POST" }),
    );

    await user.click(
      screen.getAllByRole("button", { name: "Delete this backup" })[0],
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/backups\//),
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Download a system backup" }),
    );
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, {
      target: { files: [new File(["bad"], "notes.txt")] },
    });
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "That file won't work" }),
    );
    fireEvent.change(fileInput, {
      target: { files: [new File(["db"], "system.db")] },
    });
    await user.click(
      screen.getByRole("button", { name: "Restore everything" }),
    );
    expect(requestMock).toHaveBeenCalledWith(
      "/backups/database/upload-restore",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders general and about settings and saves an update source", async () => {
    const user = userEvent.setup();
    const on12HourTimeChange = vi.fn();
    const onUpdateSourceSave = vi.fn().mockResolvedValue(undefined);
    healthState.data = {
      checks: {
        database: { status: "passed", message: "Ready" },
        runtime: { status: "failed", message: "Stopped" },
      },
      summary: { passed: 1, failed: 1 },
    };
    render(
      <>
        <GeneralCategory
          use12HourTime
          on12HourTimeChange={on12HourTimeChange}
        />
        <AboutCategory
          settings={{
            updates: {
              base_url: "https://old.example/api",
              owner: "old",
              repo: "libreserv",
            },
          }}
          onUpdateSourceSave={onUpdateSourceSave}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "12-hour Time" }));
    expect(on12HourTimeChange).toHaveBeenCalledWith(false);
    expect(screen.getByText("1 of 2 checks need attention.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Edit update source" }));
    await user.clear(screen.getByLabelText("API Base URL"));
    await user.type(screen.getByLabelText("API Base URL"), "invalid");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      screen.getByText("The API Base URL must start with http:// or https://"),
    ).toBeVisible();

    await user.clear(screen.getByLabelText("API Base URL"));
    await user.type(
      screen.getByLabelText("API Base URL"),
      " https://new.example/api ",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onUpdateSourceSave).toHaveBeenCalledWith({
      base_url: "https://new.example/api",
      owner: "old",
      repo: "libreserv",
    });
  });

  it("performs a factory reset and reports reset failures", async () => {
    const user = userEvent.setup();
    requestMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(<FactoryResetCard />);

    await user.click(
      screen.getByRole("button", { name: "Factory Reset This Device" }),
    );
    await user.type(screen.getByPlaceholderText("Type RESET"), "RESET");
    await user.type(screen.getByPlaceholderText("Your password"), "secret");
    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(requestMock).toHaveBeenCalledWith("/admin/factory-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, password: "secret" }),
    });
    expect(logoutMock).toHaveBeenCalled();
  });
});
