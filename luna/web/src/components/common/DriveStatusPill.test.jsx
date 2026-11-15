import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DriveStatusPill from "./DriveStatusPill.jsx";

const FAILING = {
  available: true,
  reason: null,
  verdict: "failing",
  overall: "failed",
  signals: [{ kind: "self_check_failed", level: "failing", value: null, limit: null }],
};
const WEAR = {
  available: true,
  reason: null,
  verdict: "watch",
  overall: "passed",
  signals: [{ kind: "reallocated_sectors", level: "watch", value: 4, limit: 100 }],
};
const OK = { available: true, reason: null, verdict: "ok", overall: "passed", signals: [] };

describe("DriveStatusPill", () => {
  it("renders null if drive is missing", () => {
    const { container } = render(<DriveStatusPill drive={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Locked for a protected drive that is closed, not Can't open", () => {
    render(<DriveStatusPill drive={{ state: "as_is", mounted: false, encrypted: true, locked: true }} />);
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.queryByText("Can't open")).toBeNull();
  });

  it("renders Ready for as_is drive", () => {
    render(<DriveStatusPill drive={{ state: "as_is" }} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders Read only for readonly drive", () => {
    render(<DriveStatusPill drive={{ state: "readonly" }} />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("renders Unplugged for missing drive", () => {
    render(<DriveStatusPill drive={{ state: "missing" }} />);
    expect(screen.getByText("Unplugged")).toBeInTheDocument();
  });

  it("renders Ejected for ejected drive", () => {
    render(<DriveStatusPill drive={{ state: "ejected" }} />);
    expect(screen.getByText("Ejected")).toBeInTheDocument();
  });

  it("renders Can't open, not Ready, for a drive Luna can't open", () => {
    render(<DriveStatusPill drive={{ state: "as_is", mounted: false }} />);
    expect(screen.getByText("Can't open")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("renders Can't open for a read-only drive Luna can't open", () => {
    render(<DriveStatusPill drive={{ state: "readonly", mounted: false }} />);
    expect(screen.getByText("Can't open")).toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
  });

  it("renders Failing and no Ready for a failing drive", () => {
    render(<DriveStatusPill drive={{ state: "as_is", mounted: true }} health={FAILING} />);
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("renders Showing wear and no Ready for a worn drive", () => {
    render(<DriveStatusPill drive={{ state: "as_is" }} health={WEAR} />);
    expect(screen.getByText("Showing wear")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("keeps Ready for a healthy drive and while health is still loading", () => {
    const { rerender } = render(<DriveStatusPill drive={{ state: "as_is" }} health={OK} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    rerender(<DriveStatusPill drive={{ state: "as_is" }} health={undefined} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("puts Unplugged ahead of health", () => {
    render(<DriveStatusPill drive={{ state: "missing" }} health={FAILING} />);
    expect(screen.getByText("Unplugged")).toBeInTheDocument();
    expect(screen.queryByText("Failing")).not.toBeInTheDocument();
  });

  it("folds the drive's actions into the status pill as one layered pill", () => {
    const onActions = vi.fn();
    render(
      <DriveStatusPill
        drive={{ state: "as_is", label: "Family photos" }}
        onActions={onActions}
      />,
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Actions for Family photos" });
    more.click();
    expect(onActions).toHaveBeenCalledTimes(1);
  });

  it("keeps the status on its own when there are no actions", () => {
    render(<DriveStatusPill drive={{ state: "as_is", label: "Family photos" }} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no Problem pill for any state", () => {
    render(<DriveStatusPill drive={{ state: "as_is" }} health={FAILING} />);
    expect(screen.queryByText("Problem")).not.toBeInTheDocument();
  });
});
