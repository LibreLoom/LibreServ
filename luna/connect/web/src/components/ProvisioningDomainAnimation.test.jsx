import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProvisioningDomainAnimation } from "./ProvisioningDomainAnimation.jsx";

describe("ProvisioningDomainAnimation", () => {
  it("renders the constant suffix and region label", () => {
    render(<ProvisioningDomainAnimation domain="kitchen" />);
    expect(screen.getByText(/\.luna\.servers\.libreloom\.org/)).toBeTruthy();
    expect(screen.getByRole("region", { name: /Provisioning domain kitchen\.luna\.servers\.libreloom\.org/i })).toBeTruthy();
  });
});
