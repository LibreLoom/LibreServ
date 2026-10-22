import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./RemoteCategory.jsx", () => ({ default: () => <section aria-label="remote access" /> }));
vi.mock("./CloudBackupCategory.jsx", () => ({ default: () => <section aria-label="cloud backup" /> }));
vi.mock("./TailscaleCard.jsx", () => ({ default: () => <section aria-label="Tailscale" /> }));

import ExternalServicesCategory from "./ExternalServicesCategory.jsx";

describe("ExternalServicesCategory", () => {
  it("puts remote access first and cloud backup under it", () => {
    render(<ExternalServicesCategory />);
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Tailscale", "remote access", "cloud backup"]);
  });
});
