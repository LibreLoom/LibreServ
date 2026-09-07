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
});
