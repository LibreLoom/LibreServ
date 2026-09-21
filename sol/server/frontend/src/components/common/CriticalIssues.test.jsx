import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CriticalIssues from "./CriticalIssues.jsx";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { .../** @type {object} */ (actual), createPortal: (node) => node };
});

vi.mock("../../hooks/useSystemHealthCheck", () => ({
  useSystemHealthCheck: vi.fn(),
}));

import { useSystemHealthCheck } from "../../hooks/useSystemHealthCheck";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe("CriticalIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the healthy state when all checks pass", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(
      /** @type {any} */({ data: { checks: {} }, isLoading: false, error: null }),
    );
    render(<CriticalIssues />, { wrapper });
    expect(screen.getByText("All systems healthy")).toBeInTheDocument();
  });

  it("shows the issue count and opens the dropdown", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(
      /** @type {any} */({
        data: { checks: { disk_space: { status: "failed", message: "low" } } },
        isLoading: false,
        error: null,
      }),
    );
    render(<CriticalIssues />, { wrapper });
    expect(screen.getByText("1 issue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /critical issue/i })).toBeInTheDocument();
  });

  it("renders nothing while loading", () => {
    vi.mocked(useSystemHealthCheck).mockReturnValue(
      /** @type {any} */({ data: null, isLoading: true, error: null }),
    );
    const { container } = render(<CriticalIssues />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });
});