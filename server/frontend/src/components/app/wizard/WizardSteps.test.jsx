import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  copyMock,
  eventSources,
  navigateMock,
  requestMock,
} = vi.hoisted(() => ({
  copyMock: vi.fn(),
  eventSources: [],
  navigateMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.jsx", () => ({
  useAuth: () => ({ request: requestMock }),
}));
vi.mock("../../../utils/clipboard.js", () => ({
  copyWithFeedback: copyMock,
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, useNavigate: () => navigateMock };
});
vi.mock("../../ui/Button.jsx", () => ({
  default: ({
    children,
    disabled,
    loading,
    onClick,
    type = "button",
  }) => (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../ui/TypewriterLoader.jsx", () => ({
  default: ({ message }) => <div>{message}</div>,
}));
vi.mock("../../cards/Card.jsx", () => ({
  default: ({ children }) => <section>{children}</section>,
}));
vi.mock("../../common/AppIcon.jsx", () => ({
  default: ({ appId }) => <span>{appId}</span>,
}));
vi.mock("./ConfigFieldRenderer.jsx", () => ({
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

class EventSourceMock {
  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    eventSources.push(this);
  }
}
vi.stubGlobal("EventSource", EventSourceMock);

import ConfigureStep from "./ConfigureStep.jsx";
import NoDomainWarningStep from "./NoDomainWarningStep.jsx";
import OverviewStep from "./OverviewStep.jsx";
import ProgressStep from "./ProgressStep.jsx";
import SubdomainStep from "./SubdomainStep.jsx";
import WizardStepper from "./WizardStepper.jsx";

const response = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  copyMock.mockReset();
  eventSources.length = 0;
  navigateMock.mockReset();
  requestMock.mockReset();
  requestMock.mockResolvedValue(response({ status: "installing" }));
});

describe("installation wizard steps", () => {
  it("renders overview requirements and access warnings", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onContinue = vi.fn();
    render(
      <OverviewStep
        app={{
          id: "notes",
          name: "Notes",
          description: "Keep notes",
          requirements: {
            min_ram: "1 GB",
            min_cpu: 2,
            min_disk: "5 GB",
          },
        }}
        features={{ access_model: "shared_account" }}
        onBack={onBack}
        onContinue={onContinue}
      />,
    );

    expect(screen.getByText("Shared Account")).toBeVisible();
    expect(screen.getByText("1 GB")).toBeVisible();
    expect(screen.getByText("2 cores")).toBeVisible();
    expect(screen.getByText("5 GB")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onBack).toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalled();
  });

  it("validates basic and advanced configuration", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    const onContinue = vi.fn();
    const app = {
      name: "Notes",
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
    };
    const { rerender } = render(
      <ConfigureStep
        app={app}
        config={{}}
        onConfigChange={onConfigChange}
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByText("Host is required")).toBeVisible();
    rerender(
      <ConfigureStep
        app={app}
        config={{ host: "notes", port: "70000" }}
        onConfigChange={onConfigChange}
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByText("Port must be between 1 and 65535")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Advanced Settings/ }));
    await user.click(screen.getByLabelText("Debug"));
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ debug: true }),
    );
    rerender(
      <ConfigureStep
        app={app}
        config={{ host: "notes", port: "8080" }}
        onConfigChange={onConfigChange}
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("checks subdomain availability and continues", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const onSubdomainChange = vi.fn();
    requestMock.mockResolvedValue(response({ available: true }));
    render(
      <SubdomainStep
        app={{ name: "My Notes" }}
        domain="example.test"
        onSubdomainChange={onSubdomainChange}
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );

    const input = screen.getByLabelText("Subdomain");
    await user.type(input, "notes");
    await user.tab();
    expect(await screen.findByText("This subdomain is available")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubdomainChange).toHaveBeenCalledWith("notes");
    expect(onContinue).toHaveBeenCalled();
  });

  it("shows local-only guidance and wizard progress", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(
      <>
        <NoDomainWarningStep
          app={{ name: "Notes" }}
          onBack={() => {}}
          onContinue={onContinue}
        />
        <WizardStepper currentStep={3} hasSubdomainStep={false} />
      </>,
    );

    expect(screen.getByText("Domain Required")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /Set Up Remote Access/ }),
    );
    expect(navigateMock).toHaveBeenCalledWith("/settings/network");
    await user.click(
      screen.getByRole("button", { name: /Install Anyway/ }),
    );
    expect(onContinue).toHaveBeenCalled();
  });

  it("advances install phases from live output and copies details", async () => {
    const user = userEvent.setup();
    copyMock.mockImplementation(async (_text, setCopied) => setCopied(true));
    render(<ProgressStep instanceId="instance-1" onComplete={() => {}} hasDomain />);

    const stream = eventSources[0];
    act(() => {
      for (const content of [
        "pull image",
        "compose up",
        "system-setup configuring",
        "all containers running",
        "creating route",
        "requesting https certificate",
      ]) {
        stream.onmessage({
          data: JSON.stringify({ type: "stdout", content }),
        });
      }
    });

    expect(screen.getByText("View installation output")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /View installation output/ }),
    );
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyMock).toHaveBeenCalledWith(
      expect.stringContaining("pull image"),
      expect.any(Function),
    );
    act(() => stream.onerror());
    expect(stream.close).toHaveBeenCalled();
  });

  it("summarizes installation stream errors and exposes raw details", async () => {
    const user = userEvent.setup();
    copyMock.mockImplementation(async (_text, setCopied) => setCopied(true));
    render(<ProgressStep instanceId="instance-2" onComplete={() => {}} />);

    const stream = eventSources[0];
    act(() =>
      stream.onmessage({
        data: JSON.stringify({
          type: "error",
          error: "port is already in use",
        }),
      }),
    );

    expect(
      await screen.findByText(
        "Another app is already using a connection this app needs.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /What went wrong/ }));
    await user.click(screen.getByRole("button", { name: /Copy error/ }));
    expect(copyMock).toHaveBeenCalledWith(
      "port is already in use",
      expect.any(Function),
    );
  });

  it("completes from a running status with a ready domain route", async () => {
    const onComplete = vi.fn();
    requestMock.mockImplementation(async (path) => {
      if (path === "/apps/instance-3/status") {
        return response({ status: "running" });
      }
      if (path === "/network/routes") {
        return response({
          routes: [
            {
              app_id: "instance-3",
              subdomain: "notes",
              domain: "example.test",
            },
          ],
        });
      }
      return response({ domains: ["notes.example.test"] });
    });
    render(<ProgressStep instanceId="instance-3" onComplete={onComplete} hasDomain />);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("/network/status"),
    );
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        status: "running",
        subdomain: "notes",
        domain: "example.test",
      }),
    );
  });
});
