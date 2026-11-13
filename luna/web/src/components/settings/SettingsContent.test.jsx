import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./categories/AppearanceCategory.jsx", () => ({ default: () => <section aria-label="appearance" /> }));
vi.mock("./categories/CloudBackupCategory.jsx", () => ({ default: () => <section aria-label="cloud backup" /> }));
vi.mock("./categories/RemoteCategory.jsx", () => ({ default: () => <section aria-label="luna connect" /> }));
vi.mock("./categories/DevicesCategory.jsx", () => ({ default: () => <section aria-label="devices" /> }));
vi.mock("./categories/AccessCategory.jsx", () => ({ default: () => <section aria-label="security" /> }));
vi.mock("./categories/UsersCategory.jsx", () => ({ default: () => <section aria-label="users" /> }));
vi.mock("./categories/AboutCategory.jsx", () => ({ default: () => <section aria-label="about" /> }));

import SettingsContent from "./SettingsContent.jsx";

describe("SettingsContent", () => {
  it("sends the retired Cloud backup id to the merged Luna Connect entry", () => {
    render(<SettingsContent category="cloud_backup" />);
    expect(screen.getByRole("heading", { level: 1, name: "Luna Connect" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "luna connect" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "cloud backup" })).toBeTruthy();
  });

  it("titles and draws the Luna Connect category with cloud backup inside", () => {
    render(<SettingsContent category="luna_connect" />);
    expect(screen.getByRole("heading", { level: 1, name: "Luna Connect" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "luna connect" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "cloud backup" })).toBeTruthy();
  });

  it("falls back to Appearance for the retired External services id, not a card", () => {
    render(<SettingsContent category="external_services" />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "appearance" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "cloud backup" })).toBeNull();
    expect(screen.queryByRole("region", { name: "luna connect" })).toBeNull();
  });
});
