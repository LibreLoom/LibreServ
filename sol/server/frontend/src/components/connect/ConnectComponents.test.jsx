import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("@libreloom/ui/utils/clipboard.js", () => ({
  canUseClipboard: () => clipboardState.ok,
  copyWithFeedback: copyMock,
}));
vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = /** @type {object} */ (await importOriginal());
  return {
    ...original,
    Link: ({ children, to }) => <a href={to}>{children}</a>,
  };
});
vi.mock("@libreloom/ui/components/cards/ModalCard.jsx", () => ({
  default: ({ children, onClose, title, open = true }) => open ? (
    <div role="dialog" aria-label={typeof title === "string" ? title : "Email"}>
      <button type="button" onClick={onClose}>Close modal</button>
      {typeof children === "function" ? children({ close: onClose }) : children}
    </div>
  ) : null,
}));
vi.mock("@libreloom/ui/components/cards/Card.jsx", () => ({
  default: ({ children, headerActions, title }) => (
    <section>
      <h2>{title}</h2>
      {headerActions}
      {children}
    </section>
  ),
}));
vi.mock("@libreloom/ui/components/common/Toggle.jsx", () => ({
  default: ({ checked, label, onChange }) => (
    <button type="button" aria-pressed={checked} onClick={() => onChange(!checked)}>
      {label}
    </button>
  ),
}));
vi.mock("@libreloom/ui/components/common/Dropdown.jsx", () => ({
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
vi.mock("@libreloom/ui/components/ui/Button.jsx", () => ({
  default: ({
    children,
    disabled,
    loading,
    onClick,
    title,
    tooltip,
    type = /** @type {"button"|"reset"|"submit"} */ ("button"),
    ...rest
  }) => (
    <button
      {...rest}
      type={type}
      aria-label={rest["aria-label"] || title || (typeof tooltip === "string" ? tooltip : undefined)}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));
vi.mock("@libreloom/ui/components/common/Callout.jsx", () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock("@libreloom/ui/components/ui/Tooltip.jsx", () => ({
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
        services={{}}
        onActivate={onActivate}
        onDeactivate={vi.fn()}
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
       onActivate={vi.fn()} />,
    );

    expect(screen.getByText("Connect one")).toBeVisible();
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
       onClose={vi.fn()} />,
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
       onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByText("Email handled by Sol Connect")).toBeVisible();
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
       onClose={vi.fn()} />,
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
       onClose={vi.fn()} onSaved={vi.fn()} />,
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
       onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    await user.type(
      screen.getByPlaceholderText("Cloudflare Tunnel token"),
      "token",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("tunnel failed")).toBeVisible();

    updateConnectServiceMock.mockResolvedValueOnce({});
    await user.click(
      screen.getByRole("button", { name: "Use Sol Connect" }),
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
       onClose={vi.fn()} onSaved={vi.fn()} />,
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
    apiMock.mockImplementation((path) => Promise.resolve(path === "/apps"
      ? jsonResponse({ apps: [{ id: "notes", name: "Notes" }] })
      : jsonResponse({
        repositories: [
          {
            id: "custom",
            app_id: "notes",
            connect_ownership_known: true,
            name: "Notes storage",
            repo_type: "sftp",
            repo_path: "/backups",
          },
          {
            id: "connect-repo",
            connect_ownership_known: true,
            connect_managed: true,
            repo_type: "s3",
            repo_path: "bucket",
          },
        ],
      })));
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
       onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(await screen.findByText("Notes storage")).toBeVisible();
    expect(screen.getByText("Backup recovery key")).toBeVisible();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/backups/repos/connect-repo/recovery-key"));
    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    expect(screen.getByText("Add a new backup destination")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateConnectServiceMock).toHaveBeenCalledWith(
      "backup",
      "connected",
      "csrf",
    );
  });

  it("validates, creates, refreshes, confirms, and deletes a backup destination", async () => {
    const user = userEvent.setup();
    const destination = { id: "disposable", app_id: "notes", connect_managed: false, connect_ownership_known: true, repo_type: "s3", repo_path: "s3:s3.amazonaws.com/disposable" };
    let saved = false;
    let repoReads = 0;
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/apps") return Promise.resolve(jsonResponse({ apps: [{ id: "notes", name: "Notes" }] }));
      if (path === "/backups/repos" && options.method === "POST") { saved = true; return Promise.resolve(jsonResponse(destination)); }
      if (path === "/backups/repos" && options.method !== "POST") {
        repoReads += 1;
        if (repoReads === 3) return Promise.resolve({ ok: false, json: vi.fn() });
        return Promise.resolve(jsonResponse({ repositories: saved ? [destination] : [] }));
      }
      if (path === "/backups/repos/disposable" && options.method === "DELETE") { saved = false; return Promise.resolve(jsonResponse({ status: "deleted" })); }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BackupServiceModal open service={{ state: "disabled" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    expect(screen.getByText("Enter a backup destination.")).toBeVisible();

    await user.type(screen.getByPlaceholderText("s3:s3.amazonaws.com/bucket"), destination.repo_path);
    await user.type(screen.getByLabelText("Access key"), "disposable-access-key");
    await user.type(screen.getByLabelText("Secret key"), "disposable-secret-key");
    await user.type(screen.getByLabelText("Region"), "us-east-1");
    await user.click(screen.getByRole("button", { name: "Save destination" }));

    expect(apiMock).toHaveBeenCalledWith("/backups/repos", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(apiMock.mock.calls.find(([path, options]) => path === "/backups/repos" && options?.method === "POST")[1].body).app_id).toBe("notes");
    expect(await screen.findByText(destination.repo_path)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete s3 destination" }));
    expect(await screen.findByRole("dialog", { name: "Delete this backup destination?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete destination" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/backups/repos/disposable", expect.objectContaining({ method: "DELETE" })));
    expect(await screen.findByRole("status")).toHaveTextContent("Destination deleted.");
    expect(await screen.findByText("No custom backup destinations configured yet.")).toBeVisible();
  });

  it("does not invite a duplicate create when saving succeeds but refresh fails", async () => {
    const user = userEvent.setup();
    let repoReads = 0;
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/apps") return Promise.resolve(jsonResponse({ apps: [{ id: "notes", name: "Notes" }] }));
      if (path === "/backups/repos" && options.method === "POST") return Promise.resolve(jsonResponse({ id: "saved" }));
      if (path === "/backups/repos") {
        repoReads += 1;
        return Promise.resolve(repoReads === 1 ? jsonResponse({ repositories: [] }) : { ok: false, json: vi.fn() });
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BackupServiceModal open service={{ state: "disabled" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    await user.selectOptions(screen.getAllByLabelText("Choose option")[0], "local");
    await user.type(screen.getByPlaceholderText("/path/to/backups"), "/tmp/disposable-backups");
    await user.click(screen.getByRole("button", { name: "Save destination" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Destination saved.");
    expect(screen.queryByText("Add a new backup destination")).not.toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([path, options]) => path === "/backups/repos" && options?.method === "POST")).toHaveLength(1);
  });

  it("shows delete failures in the confirmation and lets the user retry", async () => {
    const user = userEvent.setup();
    let deleteCalls = 0;
    const destination = { id: "retained", app_id: "notes", is_system: false, connect_managed: false, connect_ownership_known: true, repo_type: "local", repo_path: "/tmp/retained" };
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/apps") return Promise.resolve(jsonResponse({ apps: [{ id: "notes", name: "Notes" }] }));
      if (path === "/backups/repos/retained" && options.method === "DELETE") {
        deleteCalls += 1;
        return Promise.resolve(deleteCalls === 1
          ? { ok: false, status: 409, json: vi.fn().mockResolvedValue({ error: "This destination still has saved backups. Delete those backups first to keep them available for restore." }) }
          : jsonResponse({ status: "deleted" }));
      }
      return Promise.resolve(jsonResponse({ repositories: [destination] }));
    });
    render(<BackupServiceModal open service={{ state: "byo" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Delete local destination" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this backup destination?" });
    await user.click(screen.getByRole("button", { name: "Delete destination" }));
    expect(await within(confirmation).findByRole("status")).toHaveTextContent(/This destination still has saved backups/);
    expect(confirmation).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete destination" }));
    await waitFor(() => expect(deleteCalls).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this backup destination?" })).not.toBeInTheDocument());
  });

  it("does not offer deletion for destinations with unknown ownership", async () => {
    const unmarkedRepo = { id: "legacy", app_id: "", connect_ownership_known: false, connect_managed: false, repo_type: "s3", repo_path: "s3:legacy.example/backups" };
    apiMock.mockImplementation((path) => Promise.resolve(path === "/apps"
      ? jsonResponse({ apps: [{ id: "notes", name: "Notes" }] })
      : jsonResponse({ repositories: [unmarkedRepo, { id: "system", is_system: true, repo_type: "local", repo_path: "/tmp/system" }] })));
    render(<BackupServiceModal open service={{ state: "byo" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText("s3:legacy.example/backups")).toBeVisible();
    expect(screen.queryByText("/tmp/system")).not.toBeInTheDocument();
    expect(screen.getByText("Sol can't confirm who manages this destination.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete s3 destination" })).not.toBeInTheDocument();
  });

  it("does not show system repositories as user-managed destinations", async () => {
    const systemRepo = { id: "system", app_id: "", is_system: true, connect_managed: false, repo_type: "local", repo_path: "/tmp/system-backup" };
    const customRepo = { id: "custom", app_id: "notes", is_system: false, connect_managed: false, connect_ownership_known: true, repo_type: "local", repo_path: "/tmp/custom-backup" };
    apiMock.mockImplementation((path) => Promise.resolve(path === "/apps"
      ? jsonResponse({ apps: [{ id: "notes", name: "Notes" }] })
      : jsonResponse({ repositories: [systemRepo, customRepo] })));
    render(<BackupServiceModal open service={{ state: "byo" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText("/tmp/custom-backup")).toBeVisible();
    expect(screen.queryByText("/tmp/system-backup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete local destination" })).toBeVisible();
  });

  it("shows an app destination conflict inline", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/apps") return Promise.resolve(jsonResponse({ apps: [{ id: "notes", name: "Notes" }] }));
      if (path === "/backups/repos" && options.method === "POST") return Promise.resolve({ ok: false, status: 409, json: vi.fn().mockResolvedValue({ error: "This app already has a backup destination. Delete it before adding another." }) });
      return Promise.resolve(jsonResponse({ repositories: [] }));
    });
    render(<BackupServiceModal open service={{ state: "disabled" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    await user.selectOptions(screen.getAllByLabelText("Choose option")[0], "local");
    await user.type(screen.getByPlaceholderText("/path/to/backups"), "/tmp/disposable-backups");
    await user.click(screen.getByRole("button", { name: "Save destination" }));

    expect(await screen.findByText("This app already has a backup destination. Delete it before adding another.")).toBeVisible();
    expect(screen.getByText("Add a new backup destination")).toBeVisible();
  });

  it("lets the user retry when the app list fails to load", async () => {
    const user = userEvent.setup();
    let appReads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/apps") {
        appReads += 1;
        return Promise.resolve(appReads === 1
          ? { ok: false, json: vi.fn() }
          : jsonResponse({ apps: [{ id: "notes", name: "Notes" }] }));
      }
      return Promise.resolve(jsonResponse({ repositories: [] }));
    });
    render(<BackupServiceModal open service={{ state: "disabled" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add Destination/ }));
    expect(await screen.findByText("Could not load your apps.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Notes")).toBeVisible();
    expect(appReads).toBe(2);
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
            connect_managed: false,
            connect_ownership_known: true,
            repo_type: "s3",
            repo_path: "fallback",
          },
        ]}
       onClose={vi.fn()} onSaved={vi.fn()} />,
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
      expect.objectContaining({ onError: expect.any(Function) }),
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
