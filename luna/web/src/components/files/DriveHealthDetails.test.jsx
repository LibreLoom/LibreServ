import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DriveHealthDetails from "./DriveHealthDetails.jsx";

const BASE = {
  available: true, reason: null, verdict: "ok", overall: "passed", temperature_c: 34,
  temperature_max_c: 60, temperature_max_source: "typical", reallocated_sectors: 0,
  pending_sectors: 0, uncorrectable_sectors: 0, status_bits: 0, signals: [],
};

describe("DriveHealthDetails", () => {
  it("shows What to do with three steps for a failing drive", () => {
    render(
      <DriveHealthDetails
        defaultOpen
        health={{
          ...BASE, verdict: "failing", overall: "failed", reallocated_sectors: 120, temperature_c: 55,
          signals: [
            { kind: "self_check_failed", level: "failing", value: null, limit: null },
            { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Drive health/i })).toBeInTheDocument();
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("What to do")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").filter((li) => li.tagName === "LI")).toHaveLength(3);
  });

  it("shows 48°C · normal for a worn drive that is not hot", () => {
    render(
      <DriveHealthDetails
        defaultOpen
        health={{
          ...BASE, verdict: "watch", reallocated_sectors: 4, temperature_c: 48,
          signals: [{ kind: "reallocated_sectors", level: "watch", value: 4, limit: 100 }],
        }}
      />,
    );
    expect(screen.getByText("48°C · normal")).toBeInTheDocument();
    expect(screen.getByText("Showing wear")).toBeInTheDocument();
    expect(screen.getByText("What to do")).toBeInTheDocument();
  });

  it("has no steps for a healthy drive", () => {
    render(<DriveHealthDetails defaultOpen health={BASE} />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("What to do")).not.toBeInTheDocument();
  });

  it("renders nothing for a drive without a hard drive report", () => {
    const { container } = render(
      <DriveHealthDetails health={{ ...BASE, available: false, reason: "not_a_hard_drive", verdict: "unknown" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
