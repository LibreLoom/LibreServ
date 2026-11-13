import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./categories/CloudBackupCategory.jsx", () => ({ default: () => <section aria-label="cloud backup" /> }));
vi.mock("./categories/RemoteCategory.jsx", () => ({ default: () => <section aria-label="luna connect" /> }));

import { visibleCategories } from "./settingsCategories.js";
import { CATEGORY_COMPONENTS } from "./categoryComponents.js";
import LunaConnectCategory from "./categories/LunaConnectCategory.jsx";

const ids = (isAdmin, connectActive) => visibleCategories(isAdmin, connectActive).map((c) => c.id);

describe("visibleCategories", () => {
  it("gives everyone one Luna Connect entry, with cloud backup inside", () => {
    for (const isAdmin of [false, true]) {
      expect(ids(isAdmin, false)).toContain("luna_connect");
      expect(ids(isAdmin, true)).toContain("luna_connect");
      expect(ids(isAdmin, false)).not.toContain("cloud_backup");
    }
  });

  it("still hides Admin-only categories from Members", () => {
    expect(ids(false, true)).not.toContain("users");
    expect(ids(false, true)).not.toContain("about");
    expect(ids(true, true)).toContain("users");
  });

  it("keeps Luna Connect before Appearance", () => {
    expect(ids(true, true).slice(0, 2)).toEqual(["luna_connect", "appearance"]);
  });

  it("never offers the retired External services category", () => {
    for (const [isAdmin, connect] of [[true, true], [true, false], [false, true], [false, false]]) {
      expect(ids(isAdmin, connect)).not.toContain("external_services");
    }
  });
});

describe("category components", () => {
  it("maps the merged entry and the old Cloud backup id to the same component", () => {
    expect(CATEGORY_COMPONENTS.cloud_backup).toBe(LunaConnectCategory);
    expect(CATEGORY_COMPONENTS.luna_connect).toBe(LunaConnectCategory);
    expect(CATEGORY_COMPONENTS.external_services).toBeUndefined();
  });

  it("draws the connect card and the cloud backup card together", () => {
    const Connect = CATEGORY_COMPONENTS.luna_connect;
    render(<Connect />);
    expect(screen.getByRole("region", { name: "luna connect" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "cloud backup" })).toBeTruthy();
  });
});
