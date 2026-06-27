import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SystemHealthCard from "./SystemHealthCard";

const defaultProps = {
  checks: {},
  overallPass: true,
  loading: false,
  error: undefined,
};

describe("SystemHealthCard", () => {
  it("shows the overall healthy status when overallPass is true", () => {
    render(<SystemHealthCard {...defaultProps} overallPass={true} />);
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("shows 'Needs attention' when overallPass is false", () => {
    render(<SystemHealthCard {...defaultProps} overallPass={false} />);
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("shows a checking message while loading", () => {
    render(<SystemHealthCard {...defaultProps} loading={true} />);
    expect(screen.getByText(/checking/i)).toBeTruthy();
  });

  it("shows a plain-language message on error", () => {
    render(<SystemHealthCard {...defaultProps} error="boom" />);
    expect(screen.getByText(/couldn’t check system health/i)).toBeTruthy();
  });

  it("maps technical check names to plain-language labels", () => {
    const checks = {
      disk_space: { status: "passed", message: "12 GB free" },
      smtp: { status: "passed", message: "SMTP server reachable" },
      caddy_certs_writable: { status: "failed", message: "not writable" },
    };
    render(<SystemHealthCard {...defaultProps} checks={checks} />);
    expect(screen.getByText("Storage space")).toBeTruthy();
    expect(screen.getByText("Email delivery")).toBeTruthy();
    expect(screen.getByText("HTTPS certificate folder")).toBeTruthy();
    // messages are surfaced too
    expect(screen.getByText("12 GB free")).toBeTruthy();
  });

  it("prettifies unknown check names as a fallback", () => {
    const checks = { some_new_check: { status: "passed", message: "ok" } };
    render(<SystemHealthCard {...defaultProps} checks={checks} />);
    expect(screen.getByText("Some New Check")).toBeTruthy();
  });

  it("shows a no-checks message when the checks map is empty", () => {
    render(<SystemHealthCard {...defaultProps} checks={{}} />);
    expect(screen.getByText(/no checks available/i)).toBeTruthy();
  });
});