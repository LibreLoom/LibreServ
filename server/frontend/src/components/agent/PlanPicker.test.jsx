import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PlanPicker from "./PlanPicker.jsx";

describe("PlanPicker", () => {
  it("renders all three plan options", () => {
    render(<PlanPicker currentPlanId="free" onSelect={() => {}} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Basic Support")).toBeInTheDocument();
    expect(screen.getByText("Premium Support")).toBeInTheDocument();
  });

  it("shows prices for each plan", () => {
    render(<PlanPicker currentPlanId="free" onSelect={() => {}} />);
    expect(screen.getByText("$0/mo")).toBeInTheDocument();
    expect(screen.getByText("$15/mo")).toBeInTheDocument();
    expect(screen.getByText("$25/mo")).toBeInTheDocument();
  });

  it("selects the current plan by default", () => {
    render(<PlanPicker currentPlanId="basic" onSelect={() => {}} />);
    const basicButton = screen.getAllByRole("button").find((b) => b.textContent?.includes("Basic Support"));
    expect(basicButton?.className).toContain("border-accent");
  });

  it("calls onSelect with selected plan ID", () => {
    let selectedId = null;
    const onSelect = (id) => { selectedId = id; };
    render(<PlanPicker currentPlanId="free" onSelect={onSelect} />);

    const premiumButton = screen.getAllByRole("button").find((b) => b.textContent?.includes("Premium Support"));
    fireEvent.click(premiumButton);

    const confirmButton = screen.getByRole("button", { name: /Choose Premium Support/ });
    fireEvent.click(confirmButton);

    expect(selectedId).toBe("premium");
  });

  it("calls onSkip when skip is clicked", () => {
    let skipped = false;
    render(<PlanPicker currentPlanId="free" onSelect={() => {}} onSkip={() => { skipped = true; }} />);

    const skipButton = screen.getByText("Skip for now");
    fireEvent.click(skipButton);

    expect(skipped).toBe(true);
  });

  it("shows Continue with Free when free plan is selected", () => {
    render(<PlanPicker currentPlanId="free" onSelect={() => {}} />);
    expect(screen.getByText("Continue with Free")).toBeInTheDocument();
  });

  it("shows feature lists", () => {
    render(<PlanPicker currentPlanId="free" onSelect={() => {}} />);
    expect(screen.getByText(/\$10 monthly credit for AI actions/)).toBeInTheDocument();
    expect(screen.getByText(/Option to escalate to human support/)).toBeInTheDocument();
  });
});
