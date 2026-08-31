import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMock,
  clipboardState,
  copyMock,
  updateAISettingsMock,
  updateConnectServiceMock,
  updateNotificationsMock,
} = vi.hoisted(() => ({
  apiMock: vi.fn(),
  clipboardState: { ok: true },
  copyMock: vi.fn(),
  updateAISettingsMock: vi.fn(),
  updateConnectServiceMock: vi.fn(),
  updateNotificationsMock: vi.fn(),
}));

vi.mock("../../lib/api.js", () => ({ default: apiMock }));
vi.mock("../../lib/connect-api.js", () => ({
  updateConnectService: updateConnectServiceMock,
}));
vi.mock("../../lib/settings-api.js", () => ({
  updateAISettings: updateAISettingsMock,
}));
vi.mock("../../lib/notifications-api.js", () => ({
  updateNotifications: updateNotificationsMock,
}));
vi.mock("../../utils/clipboard.js", () => ({
  canUseClipboard: () => clipboardState.ok,
  copyWithFeedback: copyMock,
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    Link: ({ children, to }) => <a href={to}>{children}</a>,
  };
});
vi.mock("../cards/ModalCard.jsx", () => ({
  default: ({ children, onClose, title }) => (
    <div role="dialog" aria-label={typeof title === "string" ? title : "Email"}>
      <button type="button" onClick={onClose}>Close modal</button>
      {typeof children === "function" ? children({ close: onClose }) : children}
    </div>
  ),
}));
vi.mock("../cards/Card.jsx", () => ({
  default: ({ children, headerActions, title }) => (
    <section>
      <h2>{title}</h2>
      {headerActions}
      {children}
    </section>
  ),
}));
vi.mock("../common/Toggle.jsx", () => ({
  default: ({ checked, label, onChange }) => (
    <button type="button" aria-pressed={checked} onClick={() => onChange(!checked)}>
      {label}
    </button>
  ),
}));
vi.mock("../common/Dropdown.jsx", () => ({
  default: ({ options, value, onChange, placeholder }) => (
    <select
      aria-label={placeholder || "Choose option"}
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
vi.mock("../ui/Button.jsx", () => ({
  default: ({
    children,
    disabled,
    loading,
    onClick,
    title,
    type = "button",
  }) => (
    <button
      type={type}
      aria-label={title}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));
vi.mock("../common/Callout.jsx", () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock("../ui/Tooltip.jsx", () => ({
  InfoHint: ({ content }) => <span>{content}</span>,
  TermHint: ({ children }) => <span>{children}</span>,
}));

import AIServiceModal from "./AIServiceModal.jsx";
import BackupServiceModal from "./BackupServiceModal.jsx";
import ConnectStatusCard from "./ConnectStatusCard.jsx";
import DomainServiceModal from "./DomainServiceModal.jsx";
import EmailServiceModal from "./EmailServiceModal.jsx";
import RecoveryKeyCard from "./RecoveryKeyCard.jsx";
import TunnelServiceModal from "./TunnelServiceModal.jsx";
import { getConnectWarning } from "./connect-utils.js";

const jsonResponse = (data) => ({
  ok: true,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  apiMock.mockReset();
  copyMock.mockReset();
  updateAISettingsMock.mockReset();
  updateConnectServiceMock.mockReset();
  updateNotificationsMock.mockReset();
  clipboardState.ok = true;
  apiMock.mockResolvedValue(jsonResponse({}));
  updateAISettingsMock.mockResolvedValue({});
  updateConnectServiceMock.mockResolvedValue({});
  updateNotificationsMock.mockResolvedValue({});
});

describe("connect component coverage", () => {
  it("classifies Connect warnings", () => {
    expect(getConnectWarning("smtp", null)).toEqual({
      show: true,
      label: "Connect not connected",
      type: "warning",
    });
    expect(
      getConnectWarning("smtp", {
        connected: true,
        plan: { name: "Free" },
        services: { smtp: { state: "unavailable" } },
      }),
    ).toEqual({
      show: true,
      label: "Not available on Free",
      type: "warning",
    });
    expect(
      getConnectWarning("smtp", {
        connected: true,
        services: { smtp: { state: "connected" } },
      }),
    ).toEqual({ show: false, label: "", type: "" });
  });

  it("activates Connect and explains activation failures", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn().mockRejectedValueOnce(new Error("Key expired"));
    const onOpenPlanPage = vi.fn();
    render(
      <ConnectStatusCard
        connected={false}
        onActivate={onActivate}
        onOpenPlanPage={onOpenPlanPage}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add Connect" }));
    const keyInput = screen.getByPlaceholderText("Paste your Connect key here");
    await user.type(keyInput, "bad-key");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Key expired")).toBeVisible();
    expect(screen.getByRole("link", { name: /Get help fixing this/ })).toHaveAttribute(
      "href",
      "/troubleshoot?issue=connect-key",
    );

    onActivate.mockResolvedValueOnce(undefined);
    await user.clear(keyInput);
    await user.type(keyInput, "good-key");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onActivate).toHaveBeenLastCalledWith("good-key");

    await user.click(
      screen.getByRole("button", {
        name: "Create one at connect.serv.libreloom.org",
      }),
    );
    expect(onOpenPlanPage).toHaveBeenCalled();
  });

  it("renders connected plan status and actions", async () => {
    const user = userEvent.setup();
    const onDeactivate = vi.fn();
    const onOpenPlanPage = vi.fn();
    render(
      <ConnectStatusCard
        connected
        plan={{ id: "one" }}
        connectKeyHint="…abcd"
        services={{
          smtp: { state: "connected" },
          backup: { state: "disabled" },
        }}
        onDeactivate={onDeactivate}
        onOpenPlanPage={onOpenPlanPage}
      />,
    );

    expect(screen.getByText("Connect One")).toBeVisible();
    expect(screen.getByText("1 of 2 services active")).toBeVisible();
    expect(screen.getByText("Key: …abcd")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Manage Plan/ }));
    await user.click(screen.getByRole("button", { name: /Disconnect/ }));
    expect(onOpenPlanPage).toHaveBeenCalled();
    expect(onDeactivate).toHaveBeenCalled();
  });

  it("validates and saves bring-your-own email settings", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <EmailServiceModal
        open
        service={{ state: "byo" }}
        connectStatus={{ connected: true, services: {} }}
        csrfToken="csrf"
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByText(/Enter the mail server address/),
    ).toBeVisible();

    await user.type(screen.getByPlaceholderText("smtp.example.com"), "smtp.test");
    const port = screen.getByPlaceholderText("587");
    await user.clear(port);
    await user.type(port, "70000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/valid port number/)).toBeVisible();

    await user.clear(port);
    await user.type(port, "465");
    await user.type(
      screen.getByPlaceholderText("postmaster@example.com"),
      "user",
    );
    await user.type(
      screen.getByPlaceholderText("Password or API key from your email provider"),
      "secret",
    );
    await user.type(
      screen.getByPlaceholderText("noreply@yourdomain.com"),
      "from@example.test",
    );
    await user.click(screen.getByRole("button", { name: "Use TLS" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateConnectServiceMock).toHaveBeenCalledWith(
      "smtp",
      "byo",
      "csrf",
    );
    expect(updateNotificationsMock).toHaveBeenCalledWith(
      {
        smtp: {
          host: "smtp.test",
          port: 465,
          username: "user",
          password: "secret",
          from: "from@example.test",
          use_tls: false,
        },
      },
      "csrf",
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves Connect email and displays provider errors", async () => {
    const user = userEvent.setup();
    updateConnectServiceMock.mockRejectedValueOnce(new Error("mail unavailable"));
    render(
      <EmailServiceModal
        open
        service={{ state: "connected" }}
        connectStatus={{
          connected: true,
          services: { smtp: { state: "connected" } },
        }}
      />,
    );

    expect(screen.getByText("Email handled by LibreServ Connect")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("mail unavailable")).toBeVisible();
  });

  it("edits and saves domain service modes", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { rerender } = render(
      <DomainServiceModal
        open
        service={{ state: "byo" }}
        connectStatus={{ connected: true, services: {} }}
        csrfToken="csrf"
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByPlaceholderText("yourdomain.com"), "example.test");
    await user.selectOptions(
      screen.getByLabelText("Select a DNS provider"),
      "gandi",
    );
    await user.type(
      screen.getByPlaceholderText("DNS provider API token"),
      "token",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateConnectServiceMock).toHaveBeenCalledWith(
      "domain",
      "byo",
      "csrf",
    );

    rerender(
      <DomainServiceModal
        open
        service={{ state: "connected" }}
        connectStatus={{ connected: false }}
      />,
    );
    expect(screen.getByText("Connect not connected")).toBeVisible();
  });

  it("saves tunnel modes and reports failures", async () => {
    const user = userEvent.setup();
    updateConnectServiceMock.mockRejectedValueOnce(new Error("tunnel failed"));
    render(
      <TunnelServiceModal
        open
        service={{ state: "byo" }}
        connectStatus={{ connected: true, services: {} }}
        csrfToken="csrf"
      />,
    );

    await user.type(
      screen.getByPlaceholderText("Cloudflare Tunnel token"),
      "token",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("tunnel failed")).toBeVisible();

    updateConnectServiceMock.mockResolvedValueOnce({});
    await user.click(
      screen.getByRole("button", { name: "Use LibreServ Connect" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateConnectServiceMock).toHaveBeenLastCalledWith(
      "tunnel",
      "connected",
      "csrf",
    );
  });

  it("saves custom and Connect AI settings", async () => {
    const user = userEvent.setup();
    render(
      <AIServiceModal
        open
        service={{ state: "byo" }}
        connectStatus={{ connected: true, services: {} }}
        aiSettings={{
          user_key_configured: true,
          user_base_url: "https://ai.test",
          main_model: "main",
          review_model: "review",
          available_models: [
            { id: "main", name: "Main" },
            { id: "review", name: "Review" },
          ],
        }}
        csrfToken="csrf"
      />,
    );

    await user.type(screen.getByPlaceholderText("sk-..."), "api-key");
    await user.clear(screen.getByPlaceholderText("https://api.openai.com/v1"));
    await user.type(
      screen.getByPlaceholderText("https://api.openai.com/v1"),
      "https://new-ai.test",
    );
    await user.selectOptions(
      screen.getByLabelText("Choose option"),
      "anthropic",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateConnectServiceMock).toHaveBeenCalledWith("ai", "byo", "csrf");
    expect(updateAISettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        byok_enabled: true,
        user_api_key: "api-key",
        user_base_url: "https://new-ai.test",
        user_api_format: "anthropic",
      }),
      "csrf",
    );
  });

  it("loads backup destinations and saves backup mode", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(
      jsonResponse({
        repositories: [
          {
            id: "connect-repo",
            repo_type: "s3",
            repo_path: "bucket",
            password: "key",
          },
          {
            id: "custom",
            app_id: "notes",
            name: "Notes storage",
            repo_type: "sftp",
            repo_path: "/backups",
          },
        ],
      }),
    );
    render(
      <BackupServiceModal
        open
        service={{ state: "connected" }}
        connectStatus={{
          connected: true,
          services: { backup: { state: "connected" } },
        }}
        repos={[]}
        csrfToken="csrf"
      />,
    );

    expect(await screen.findByText("Notes storage")).toBeVisible();
    expect(screen.getByText("Backup Recovery Key")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    expect(screen.getByText("Add a new backup destination")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateConnectServiceMock).toHaveBeenCalledWith(
      "backup",
      "connected",
      "csrf",
    );
  });

  it("falls back to provided backup destinations and reports save errors", async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValue(new Error("offline"));
    updateConnectServiceMock.mockRejectedValue(new Error("save failed"));
    render(
      <BackupServiceModal
        open
        service={{ state: "byo" }}
        connectStatus={{ connected: false }}
        repos={[
          {
            id: "fallback",
            app_id: "app",
            name: "Fallback storage",
            repo_type: "s3",
            repo_path: "fallback",
          },
        ]}
      />,
    );

    expect(await screen.findByText("Fallback storage")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("save failed")).toBeVisible();
  });

  it("fetches, copies, reveals, and downloads recovery keys", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(jsonResponse({ recovery_key: "recovery-secret" }));
    URL.createObjectURL = vi.fn(() => "blob:key");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <RecoveryKeyCard
        repo={{ id: "repo", repo_type: "s3", repo_path: "bucket" }}
        repoId="repo"
      />,
    );

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/backups/repos/repo/recovery-key"),
    );
    await user.click(screen.getByRole("button", { name: "Show key" }));
    expect(screen.getByText("recovery-secret")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(copyMock).toHaveBeenCalledWith(
      "recovery-secret",
      expect.any(Function),
    );
    await user.click(screen.getByRole("button", { name: "Download key file" }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("supports manual recovery-key copying when clipboard is unavailable", async () => {
    clipboardState.ok = false;
    apiMock.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<RecoveryKeyCard repo={{ password: "autogenerated" }} repoId="repo" />);

    expect(await screen.findByText("Could not load recovery key.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show key" }));
    expect(screen.getByLabelText("Recovery key")).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("Recovery key"));
  });
});
