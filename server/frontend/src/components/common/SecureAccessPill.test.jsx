import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SecureAccessPill from "./SecureAccessPill.jsx";

vi.mock("../../hooks/useSettingsStatus", () => ({
  useSettingsStatus: vi.fn(),
}));

import { useSettingsStatus } from "../../hooks/useSettingsStatus";

describe("SecureAccessPill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettingsStatus).mockReturnValue(
      /** @type {any} */({ domainConfigured: false, domain: "" }),
    );
    Object.defineProperty(window, "location", {
      value: { protocol: "http:" },
      configurable: true,
    });
  });

  it("shows the secure-access domain pill when a domain is configured", () => {
    vi.mocked(useSettingsStatus).mockReturnValue(
      /** @type {any} */({ domainConfigured: true, domain: "example.com" }),
    );
    render(<SecureAccessPill />);
    expect(screen.getByText("Access securely")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open example.com in a new tab" })).toBeInTheDocument();
  });

  it("does not show when no domain is configured", () => {
    render(<SecureAccessPill />);
    expect(screen.queryByText("Access securely")).not.toBeInTheDocument();
  });

  it("does not show when already on https", () => {
    vi.mocked(useSettingsStatus).mockReturnValue(
      /** @type {any} */({ domainConfigured: true, domain: "example.com" }),
    );
    Object.defineProperty(window, "location", {
      value: { protocol: "https:" },
      configurable: true,
    });
    render(<SecureAccessPill />);
    expect(screen.queryByText("Access securely")).not.toBeInTheDocument();
  });
});