import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("SystemHealthPill", () => {
  beforeEach(() => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: null,
      isLoading: false,
      error: null,
    }));
  });

  it("shows the healthy state when all checks pass", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: {
        overall_pass: true,
        checks: { database: { status: "passed", message: "OK", category: "system" } },
      },
      isLoading: false,
      error: null,
    }));
    renderPill();
    expect(screen.getByText("Everything looks good")).toBeInTheDocument();
  });

  it("shows an issue count when checks fail", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: {
        overall_pass: false,
        checks: {
          disk_space: { status: "failed", message: "Low space", category: "system" },
        },
      },
      isLoading: false,
      error: null,
    }));
    renderPill();
    expect(screen.getByText("1 issue")).toBeInTheDocument();
  });

  it("counts warnings as warnings when nothing failed", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: {
        overall_pass: true,
        checks: {
          database: { status: "passed", message: "OK", category: "system" },
          diagram_pack: { status: "warning", message: "Diagrams can't be opened.", category: "features" },
          video_tools: { status: "warning", message: "No video previews.", category: "features" },
        },
      },
      isLoading: false,
      error: null,
    }));
    renderPill();
    expect(screen.getByText("2 warnings")).toBeInTheDocument();
    expect(screen.queryByText("Everything looks good")).not.toBeInTheDocument();
  });

  it("calls it issues when a failure sits next to warnings", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(/** @type {any} */({
      data: {
        overall_pass: false,
        checks: {
          disk_space: { status: "failed", message: "Low space", category: "system" },
          diagram_pack: { status: "warning", message: "Diagrams can't be opened.", category: "features" },
        },
      },
      isLoading: false,
      error: null,
    }));
    renderPill();
    expect(screen.getByText("2 issues")).toBeInTheDocument();
  });
});
