import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMock,
  authRequestMock,
  clipboardState,
  clipboardCopyMock,
  copyWithFeedbackMock,
  eventSources,
  toastMock,
} = vi.hoisted(() => ({
  apiMock: vi.fn(),
  authRequestMock: vi.fn(),
  clipboardState: { ok: true },
  clipboardCopyMock: vi.fn(),
  copyWithFeedbackMock: vi.fn(),
  eventSources: [],
  toastMock: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../../lib/api.js", () => ({ default: apiMock }));
vi.mock("../../hooks/useAuth.jsx", () => ({
  useAuth: () => ({ request: authRequestMock }),
}));
vi.mock("../../context/ToastContext.jsx", () => ({
  useToast: () => toastMock,
}));
vi.mock("../../utils/clipboard.js", () => ({
  canUseClipboard: () => clipboardState.ok,
  copyToClipboard: clipboardCopyMock,
  copyWithFeedback: copyWithFeedbackMock,
}));
vi.mock("../cards/Card.jsx", () => ({
  default: ({ children, headerActions, title }) => (
    <section>
      {title && <h2>{title}</h2>}
      {headerActions}
      {children}
    </section>
  ),
}));
vi.mock("../cards/ModalCard.jsx", () => ({
  default: ({ children, footer, onClose, title }) => (
    <div role="dialog" aria-label={typeof title === "string" ? title : "Modal"}>
      <button type="button" onClick={onClose}>Close modal</button>
      {typeof children === "function" ? children({ close: onClose }) : children}
      {typeof footer === "function" ? footer({ close: onClose }) : footer}
    </div>
  ),
}));
vi.mock("../common/Toggle.jsx", () => ({
  default: ({ "aria-label": ariaLabel, checked, label, onChange }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  ),
}));
vi.mock("../common/Dropdown.jsx", () => ({
  default: ({ options, placeholder, value, onChange }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose</option>
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
    "aria-label": ariaLabel,
    children,
    disabled,
    form,
    loading,
    onClick,
    title,
    type = "button",
  }) => (
    <button
      type={type}
      form={form}
      aria-label={ariaLabel || title}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));
vi.mock("./wizard/ConfigFieldRenderer.jsx", () => ({
  default: ({ field, value, onChange }) => (
    <label>
      {field.label}
      <input
        aria-label={field.label}
        type={field.type === "boolean" ? "checkbox" : "text"}
        checked={field.type === "boolean" ? Boolean(value) : undefined}
        value={field.type === "boolean" ? undefined : value ?? ""}
        onChange={(event) =>
          onChange(
            field.type === "boolean"
              ? event.target.checked
              : event.target.value,
          )
        }
      />
    </label>
  ),
}));
vi.mock("../common/ProgressFeedback.jsx", () => ({
  ProgressFeedback: ({ onComplete, onError, title }) => (
    <div>
      <span>{title}</span>
      <button type="button" onClick={() => onComplete({ exitCode: 0 })}>
        Complete stream
      </button>
      <button
        type="button"
        onClick={() => onError({ exitCode: 2, error: "stream failed" })}
      >
        Fail stream
      </button>
    </div>
  ),
}));

class EventSourceMock {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.close = vi.fn();
    eventSources.push(this);
  }
}

vi.stubGlobal("EventSource", EventSourceMock);

import AccessControlSection from "./AccessControlSection.jsx";
import AcknowledgeRevocationModal from "./AcknowledgeRevocationModal.jsx";
import { ExposedInfoCard } from "./ExposedInfoCard.jsx";
import LogsViewer from "./LogsViewer.jsx";
import ReconfigureModal from "./ReconfigureModal.jsx";
import RevocationBanner from "./RevocationBanner.jsx";
import { ActionCard } from "./actions/ActionCard.jsx";
import { ActionConfirmModal } from "./actions/ActionConfirmModal.jsx";
import { ActionOptionsModal } from "./actions/ActionOptionsModal.jsx";
import { ActionResultModal } from "./actions/ActionResultModal.jsx";

const jsonResponse = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  apiMock.mockReset();
  authRequestMock.mockReset();
  clipboardCopyMock.mockReset();
  copyWithFeedbackMock.mockReset();
  eventSources.length = 0;
  toastMock.error.mockReset();
  toastMock.success.mockReset();
  clipboardState.ok = true;
  window.matchMedia = vi.fn(() => ({ matches: true }));
});

describe("app component coverage", () => {
  it("loads and changes internal app access", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(async (path) => {
      if (path.endsWith("/oidc")) return jsonResponse({ configured: true });
      if (path.endsWith("/oidc/access")) {
        return jsonResponse([
          { user_id: "one", username: "Ada", email: "ada@example.test" },
        ]);
      }
      if (path === "/users") {
        return jsonResponse({
          data: [
            { id: "one", username: "Ada" },
            { id: "two", username: "Lin", email: "lin@example.test" },
          ],
        });
      }
      return jsonResponse({});
    });
    render(
      <AccessControlSection
        instanceId="app-1"
        accessModel="internal"
        appName="Notes"
      />,
    );

    expect(await screen.findByText("Connected — sign-in is ready")).toBeVisible();
    expect(screen.getByText("ada@example.test")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Select a user..."), "two");
    await user.click(screen.getByRole("button", { name: /Grant access/ }));
    expect(apiMock).toHaveBeenCalledWith(
      "/apps/app-1/oidc/access",
      expect.objectContaining({ method: "POST" }),
    );
    await user.click(screen.getByRole("button", { name: /Revoke/ }));
    expect(apiMock).toHaveBeenCalledWith(
      "/apps/app-1/oidc/access/one",
      { method: "DELETE" },
    );
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("toggles external restricted access and restores state on failure", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(async (path, options) => {
      if (path.endsWith("/oidc/restricted") && !options) {
        return jsonResponse({ restricted_access: false });
      }
      if (path.endsWith("/oidc/access")) return jsonResponse([]);
      if (path === "/users") return jsonResponse({ data: [] });
      if (options?.method === "PUT") throw new Error("access failed");
      return jsonResponse({});
    });
    render(
      <AccessControlSection
        instanceId="app-2"
        accessModel="external"
        appName="Public app"
      />,
    );

    await screen.findByText("No users added yet");
    await user.click(
      screen.getByRole("button", { name: "Require LibreServ login" }),
    );
    expect(toastMock.error).toHaveBeenCalledWith("access failed");
  });

  it("renders, reveals, and copies grouped exposed information", async () => {
    const user = userEvent.setup();
    clipboardCopyMock.mockImplementation(async (_value, { onSuccess }) =>
      onSuccess(),
    );
    render(
      <ExposedInfoCard
        info={{
          password: {
            label: "Password",
            value: "secret",
            group: "credentials",
            mask_by_default: true,
            revealable: true,
            copyable: true,
          },
          url: {
            label: "Address",
            value: "https://app.example.test",
            group: "connection",
            type: "url",
          },
          note: {
            label: "Note",
            value: "Advanced value",
            group: "misc",
            advanced: true,
            description: "Extra detail",
          },
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "https://app.example.test" }))
      .toHaveAttribute("href", "https://app.example.test");
    const revealButton = screen
      .getAllByRole("button", { name: "Reveal Password" })
      .find((element) => element.tagName === "BUTTON");
    await user.click(revealButton);
    expect(
      screen
        .getAllByRole("button", { name: "Hide Password" })
        .some((element) => element.tagName === "BUTTON"),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Copy Password to clipboard" }),
    );
    expect(clipboardCopyMock).toHaveBeenCalledWith(
      "secret",
      expect.any(Object),
    );
    await user.click(screen.getByRole("button", { name: /Advanced Information/ }));
    expect(screen.getByText("Advanced value")).toBeVisible();
  });

  it("streams, filters, downloads, and recovers from log errors", async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => "blob:logs");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<LogsViewer app={{ id: "app-1", name: "Notes" }} />);

    const stream = eventSources[0];
    expect(stream.url).toContain("/apps/app-1/logs/stream");
    act(() => {
      stream.onmessage({
        data: JSON.stringify({
          type: "stdout",
          content: ["started", "error happened"].join("\n"),
        }),
      });
      stream.onmessage({
        data: JSON.stringify({ content: "ready" }),
      });
      stream.onmessage({ data: "plain line" });
    });
    await screen.findByText("error happened");

    const filters = screen.getAllByPlaceholderText("Filter logs");
    await user.type(filters[0], "error");
    expect(screen.getByText("Showing last 4 lines")).toBeVisible();
    await user.click(
      screen.getAllByRole("button", { name: "Download logs" })[0],
    );
    expect(URL.createObjectURL).toHaveBeenCalled();

    act(() => {
      stream.onmessage({ data: JSON.stringify({ error: "stream problem" }) });
      stream.onerror();
    });
    expect(stream.close).toHaveBeenCalled();
  });

  it("validates and submits app reconfiguration", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    authRequestMock.mockImplementation(async (path) => {
      if (path === "/catalog/notes") {
        return jsonResponse({
          configuration: [
            { name: "host", label: "Host", type: "text", required: true },
            { name: "port", label: "Port", type: "port" },
            {
              name: "debug",
              label: "Debug",
              type: "boolean",
              advanced: true,
            },
          ],
        });
      }
      return jsonResponse({ id: "app-1", config: { host: "new" } });
    });
    render(
      <ReconfigureModal
        app={{ id: "app-1", app_id: "notes", name: "Notes", config: {} }}
        request={authRequestMock}
        onSuccess={onSuccess}
      />,
    );

    await screen.findByLabelText("Host");
    await user.click(screen.getByRole("button", { name: "Apply & Restart" }));
    expect(screen.getByText("Host is required")).toBeVisible();
    await user.type(screen.getByLabelText("Host"), "notes");
    await user.type(screen.getByLabelText("Port"), "70000");
    await user.click(screen.getByRole("button", { name: "Apply & Restart" }));
    expect(screen.getByText("Port must be between 1 and 65535")).toBeVisible();
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Port"), "8080");
    await user.click(screen.getByRole("button", { name: /Advanced Settings/ }));
    await user.click(screen.getByLabelText("Debug"));
    await user.click(screen.getByRole("button", { name: "Apply & Restart" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(authRequestMock).toHaveBeenCalledWith(
      "/apps/app-1/config",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("acknowledges recalled versions after explicit confirmation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onAcknowledged = vi.fn();
    authRequestMock
      .mockResolvedValueOnce(jsonResponse({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    render(
      <AcknowledgeRevocationModal
        app={{
          id: "app-1",
          revocation_notice: { severity: "malicious", reason: "Unsafe" },
        }}
        onClose={onClose}
        onAcknowledged={onAcknowledged}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "I Understand the Risk" }),
    );
    await user.type(
      screen.getByPlaceholderText('Type "I understand"'),
      "I understand",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(authRequestMock).toHaveBeenCalledWith(
      "/apps/app-1/acknowledge-revocation",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onAcknowledged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("expands active and acknowledged revocation notices", async () => {
    const user = userEvent.setup();
    const onSeeDetails = vi.fn();
    const { rerender } = render(
      <RevocationBanner
        notice={{ severity: "malicious", reason: "Security problem" }}
        appName="Notes"
        onSeeDetails={onSeeDetails}
      />,
    );
    await user.click(screen.getByRole("button", { name: /More details/ }));
    expect(screen.getByText(/may allow attackers/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Acknowledge & Continue" }),
    );
    expect(onSeeDetails).toHaveBeenCalled();

    rerender(
      <RevocationBanner
        acknowledged
        notice={{
          severity: "warning",
          acknowledged_at: "2026-08-01T00:00:00Z",
        }}
        appName="Notes"
      />,
    );
    expect(screen.getByText(/Recalled version \(you acknowledged/)).toBeVisible();
  });

  it("runs action cards and confirmation modals", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    const onConfirm = vi.fn();
    const action = {
      label: "Repair",
      options: [{ name: "force" }],
      confirm: { enabled: true, message: "Continue?" },
    };
    render(
      <>
        <ActionCard action={action} onExecute={onExecute} />
        <ActionConfirmModal
          action={action}
          onConfirm={onConfirm}
          onCancel={() => {}}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onExecute).toHaveBeenCalledWith(action);
    expect(onConfirm).toHaveBeenCalled();
  });

  it("shows and copies action results across duration formats", async () => {
    const user = userEvent.setup();
    copyWithFeedbackMock.mockImplementation(async (_value, setCopied) =>
      setCopied(true),
    );
    render(
      <>
        <ActionResultModal
          result={{
            success: true,
            exit_code: 0,
            output: "done",
            duration: "1h2m3s",
          }}
          onClose={() => {}}
        />
        <ActionResultModal
          result={{
            success: false,
            error: "failed",
            duration: 500_000_000,
          }}
          onClose={() => {}}
        />
      </>,
    );

    expect(screen.getByText("1h 2m")).toBeVisible();
    expect(screen.getByText("500ms")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /View output/ }));
    await user.click(
      screen.getByRole("button", { name: "Copy output to clipboard" }),
    );
    expect(copyWithFeedbackMock).toHaveBeenCalledWith(
      "done",
      expect.any(Function),
    );
  });

  it("validates, confirms, and executes actions with options", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn().mockResolvedValue({
      result: {
        Success: true,
        ExitCode: 0,
        Output: { repaired: true },
        Duration: "2s",
      },
    });
    render(
      <ActionOptionsModal
        action={{
          name: "repair",
          label: "Repair",
          description: "Repairs the app",
          options: [
            {
              name: "target",
              label: "Target",
              type: "text",
              required: true,
            },
          ],
          confirm: { enabled: true, message: "Continue?" },
        }}
        onClose={() => {}}
        onExecute={onExecute}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Please fill in all required fields")).toBeVisible();
    await user.type(screen.getByLabelText("Target"), "database");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText('{"repaired":true}')).toBeInTheDocument();
    expect(onExecute).toHaveBeenCalledWith("repair", { target: "database" });
  });

  it("handles streamed and failed action execution", async () => {
    const user = userEvent.setup();
    const onExecute = vi
      .fn()
      .mockResolvedValueOnce({ stream_url: "/stream/one" });
    const onClose = vi.fn();
    render(
      <ActionOptionsModal
        action={{ name: "scan", label: "Scan", options: [] }}
        onClose={onClose}
        onExecute={onExecute}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Running Scan")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Fail stream" }));
    expect(await screen.findByText("stream failed")).toBeVisible();
  });
});
