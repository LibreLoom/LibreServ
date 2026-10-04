import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const health = vi.fn();
vi.mock("../../../hooks/useSystemHealthCheck.jsx", () => ({ useSystemHealthCheck: () => health() }));

import SystemChecksCard from "./SystemChecksCard.jsx";

const ok = (message = "") => ({ status: "passed", message });

describe("SystemChecksCard", () => {
  beforeEach(() => health.mockReset());

  it("shows a placeholder while the first check runs", () => {
    health.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(<SystemChecksCard />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "System checks" })).toBeInTheDocument();
  });

  it("says plainly that the checks could not run, as an alert", () => {
    health.mockReturnValue({ data: undefined, isLoading: false, error: new Error("boom") });
    render(<SystemChecksCard />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Luna couldn't run system checks right now. Try again in a moment.");
    // The red lives on the icon; the sentence itself keeps the readable text color.
    expect(alert.className).not.toMatch(/text-error/);
  });

  it("reports an all-clear", () => {
    health.mockReturnValue({
      data: { checks: { disk: ok("Plenty of space"), drives: ok() } },
      isLoading: false,
      error: null,
    });
    render(<SystemChecksCard />);
    expect(screen.getByText("All 2 checks passed.")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Plenty of space")).toBeInTheDocument();
  });

  it("counts warnings and failures, and lists the worst first", () => {
    health.mockReturnValue({
      data: {
        checks: {
          alpha: ok(),
          disk: { status: "warning", message: "Getting full" },
          drives: { status: "failed", message: "A drive is read-only" },
        },
      },
      isLoading: false,
      error: null,
    });
    render(<SystemChecksCard />);
    expect(screen.getByText("1 of 3 checks failed, plus 1 warning.")).toBeInTheDocument();
    expect(screen.getByText("Issues found")).toBeInTheDocument();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("A drive is read-only");
    expect(rows[1]).toHaveTextContent("Getting full");
  });

  it("uses a warnings-only summary and the server's own counts when it sends them", () => {
    health.mockReturnValue({
      data: {
        summary: { warnings: 2, failed: 0 },
        checks: { a: { status: "warning", message: "x" }, b: { status: "warning", message: "y" } },
      },
      isLoading: false,
      error: null,
    });
    render(<SystemChecksCard />);
    expect(screen.getByText("2 of 2 checks have warnings.")).toBeInTheDocument();
    expect(screen.getByText("Warnings")).toBeInTheDocument();
  });

  it("handles a response with no checks", () => {
    health.mockReturnValue({ data: { checks: {} }, isLoading: false, error: null });
    render(<SystemChecksCard />);
    expect(screen.getByText("No checks recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).toBeNull();
  });
});
