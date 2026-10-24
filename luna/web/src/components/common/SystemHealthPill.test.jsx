import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SystemHealthPill from "./SystemHealthPill.jsx";

vi.mock("../../hooks/useSystemHealthCheck.jsx", () => ({
  useSystemHealthCheck: vi.fn(),
}));

import { useSystemHealthCheck } from "../../hooks/useSystemHealthCheck.jsx";

function renderPill() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SystemHealthPill />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** @param {Record<string, any>} checks */
function mockChecks(checks) {
  vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
    data: { overall_pass: false, checks },
    isLoading: false,
    error: null,
  }));
}

const PASSED = { status: "passed", message: "OK", category: "system" };
const FAILED_DISK = { status: "failed", message: "Low space", category: "system" };
const WARN_DIAGRAMS = {
  status: "warning",
  message: "Diagrams can't be opened.",
  category: "features",
};
const WARN_VIDEO = { status: "warning", message: "No video previews.", category: "features" };

describe("SystemHealthPill", () => {
  beforeEach(() => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: null,
      isLoading: false,
      error: null,
    }));
  });

  it("renders nothing when every check passes", () => {
    mockChecks({ database: PASSED, clock: PASSED });
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Everything looks good")).not.toBeInTheDocument();
  });

  it("renders nothing when the only problem is a failed check", () => {
    mockChecks({ database: PASSED, disk_space: FAILED_DISK });
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("1 issue")).not.toBeInTheDocument();
    expect(screen.queryByText(/warning/)).not.toBeInTheDocument();
  });

  it("renders nothing when there are no checks at all", () => {
    mockChecks({});
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the checks are loading", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: undefined,
      isLoading: true,
      error: null,
    }));
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the checks could not be loaded", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: undefined,
      isLoading: false,
      error: new Error("network down"),
    }));
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no data", () => {
    const { container } = renderPill();
    expect(container.firstChild).toBeNull();
  });

  it("counts several warnings in the warning pill", () => {
    mockChecks({ database: PASSED, diagram_pack: WARN_DIAGRAMS, video_tools: WARN_VIDEO });
    renderPill();
    expect(screen.getByText("2 warnings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 warnings. Click to view details." })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="badge"]')).toHaveAttribute("data-variant", "warning");
  });

  it("uses the singular for one warning", () => {
    mockChecks({ diagram_pack: WARN_DIAGRAMS });
    renderPill();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.queryByText("1 warnings")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 warning. Click to view details." })).toBeInTheDocument();
  });

  it("counts only the warning when a failed check sits next to it", async () => {
    mockChecks({ disk_space: FAILED_DISK, diagram_pack: WARN_DIAGRAMS });
    renderPill();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="badge"]')).toHaveAttribute("data-variant", "warning");

    await userEvent.click(screen.getByRole("button", { name: /warning/ }));
    const dialog = await screen.findByRole("dialog", { name: "System health warnings" });
    expect(dialog).toHaveTextContent("Diagrams");
    expect(dialog).not.toHaveTextContent("Luna's own storage");
    expect(dialog).not.toHaveTextContent("Low space");
  });

  it("opens a list of the warnings with a link to the system checks", async () => {
    mockChecks({ database: PASSED, diagram_pack: WARN_DIAGRAMS, video_tools: WARN_VIDEO });
    renderPill();

    const button = screen.getByRole("button", { name: "2 warnings. Click to view details." });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: "System health warnings" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("2 warnings found")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Diagrams");
    expect(dialog).toHaveTextContent("Diagrams can't be opened.");
    expect(dialog).toHaveTextContent("Video previews");
    expect(dialog).toHaveTextContent("No video previews.");
    expect(dialog).not.toHaveTextContent("Accounts and settings");
    expect(screen.getByRole("link", { name: "Open system checks in Settings" })).toHaveAttribute(
      "href",
      "/settings#about",
    );
  });

  it("explains Luna's own storage with a hint when that check warns", async () => {
    mockChecks({
      disk_space: { status: "warning", message: "Luna's own storage is getting full.", category: "storage" },
      diagram_pack: WARN_DIAGRAMS,
    });
    renderPill();
    await userEvent.click(screen.getByRole("button", { name: /warning/ }));
    const dialog = await screen.findByRole("dialog", { name: "System health warnings" });
    expect(dialog).toHaveTextContent("Luna's own storage");
    // Only the one system-disk check gets the hint; Diagrams does not.
    expect(dialog.querySelectorAll('[data-slot="info-hint-trigger"]')).toHaveLength(1);
  });

  it("titles the list in the singular for one warning", async () => {
    mockChecks({ video_tools: WARN_VIDEO });
    renderPill();
    await userEvent.click(screen.getByRole("button", { name: /warning/ }));
    expect(await screen.findByText("1 warning found")).toBeInTheDocument();
  });

  it("closes the list when the pill is clicked again", async () => {
    mockChecks({ diagram_pack: WARN_DIAGRAMS });
    renderPill();
    const button = screen.getByRole("button", { name: /warning/ });
    await userEvent.click(button);
    await screen.findByRole("dialog", { name: "System health warnings" });
    await userEvent.click(button);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
