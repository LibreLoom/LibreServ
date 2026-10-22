import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./categories/CloudBackupCategory.jsx", () => ({ default: () => <section aria-label="cloud backup" /> }));
vi.mock("./categories/RemoteCategory.jsx", () => ({ default: () => <section aria-label="luna connect" /> }));

import { visibleCategories } from "./settingsCategories.js";
import { CATEGORY_COMPONENTS } from "./categoryComponents.js";
import CloudBackupCategory from "./categories/CloudBackupCategory.jsx";
import RemoteCategory from "./categories/RemoteCategory.jsx";

const ids = (isAdmin, connectActive) => visibleCategories(isAdmin, connectActive).map((c) => c.id);

describe("visibleCategories", () => {
  it("Member with Connect off sees neither Cloud backup nor Luna Connect", () => {
    expect(ids(false, false)).not.toContain("cloud_backup");
    expect(ids(false, false)).not.toContain("luna_connect");
  });

  it("Admin with Connect off sees neither Cloud backup nor Luna Connect", () => {
    expect(ids(true, false)).not.toContain("cloud_backup");
    expect(ids(true, false)).not.toContain("luna_connect");
  });

  it("Member with Connect on sees Cloud backup only", () => {
    const list = ids(false, true);
    expect(list).toContain("cloud_backup");
    expect(list).not.toContain("luna_connect");
  });

  it("Admin with Connect on sees both, Cloud backup first and then Luna Connect", () => {
    const list = ids(true, true);
    expect(list.slice(0, 2)).toEqual(["cloud_backup", "luna_connect"]);
  });

  it("defaults to Connect off when the flag is left out", () => {
    expect(visibleCategories(true)).toEqual(visibleCategories(true, false));
  });

  it("never offers the retired External services category", () => {
    for (const [isAdmin, connect] of [[true, true], [true, false], [false, true], [false, false]]) {
      expect(ids(isAdmin, connect)).not.toContain("external_services");
    }
  });
});

describe("category components", () => {
  it("maps Cloud backup and Luna Connect to their own cards", () => {
    expect(CATEGORY_COMPONENTS.cloud_backup).toBe(CloudBackupCategory);
    expect(CATEGORY_COMPONENTS.luna_connect).toBe(RemoteCategory);
    expect(CATEGORY_COMPONENTS.external_services).toBeUndefined();
  });

  it("draws a card for each new category", () => {
    const Cloud = CATEGORY_COMPONENTS.cloud_backup;
    const Connect = CATEGORY_COMPONENTS.luna_connect;
    render(<><Cloud /><Connect /></>);
    expect(screen.getByRole("region", { name: "cloud backup" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "luna connect" })).toBeTruthy();
  });
});
