import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PasswordStrengthChecklist from "./PasswordStrengthChecklist";

describe("PasswordStrengthChecklist", () => {
  it("renders nothing for an empty password", () => {
    const { container } = render(<PasswordStrengthChecklist password="" />);
    expect(container.querySelector("[data-slot='password-strength-checklist']")).toBeNull();
  });

  it("shows the full requirement chips and pending status", () => {
    render(<PasswordStrengthChecklist password="abc" />);
    expect(screen.getByText("12+ chars")).toBeTruthy();
    expect(screen.getByText("letters")).toBeTruthy();
    expect(screen.getByText("numbers")).toBeTruthy();
    expect(screen.getByText("symbols")).toBeTruthy();
    expect(screen.getByText("Not strong enough yet")).toBeTruthy();
    expect(screen.getByText("Weak")).toBeTruthy();
  });

  it("marks the password acceptable when policy is met", () => {
    render(<PasswordStrengthChecklist password="hunter22hunter1" />);
    expect(screen.getByText("✓ Acceptable")).toBeTruthy();
  });

  it("applies surface-aware high contrast text tokens", () => {
    const { rerender } = render(<PasswordStrengthChecklist password="hunter22hunter1" surface="secondary" />);
    const acceptableSecondary = screen.getByText("✓ Acceptable");
    expect(acceptableSecondary.className).toContain("text-primary");

    rerender(<PasswordStrengthChecklist password="hunter22hunter1" surface="primary" />);
    const acceptablePrimary = screen.getByText("✓ Acceptable");
    expect(acceptablePrimary.className).toContain("text-secondary");
    expect(acceptablePrimary.className).not.toContain("text-success");
  });

  it("styles met requirements with status tint and unmet with neutral border", () => {
    render(<PasswordStrengthChecklist password="abc" surface="primary" />);
    const lettersChip = screen.getByText("letters").closest("span");
    const lengthChip = screen.getByText("12+ chars").closest("span");

    expect(lettersChip.className).toContain("bg-success/20");
    expect(lettersChip.className).toContain("border-success/30");
    expect(lettersChip.className).toContain("text-secondary");

    expect(lengthChip.className).toContain("border-secondary/20");
    expect(lengthChip.className).toContain("text-secondary");
    expect(lengthChip.className).not.toContain("bg-success/20");
  });
});
