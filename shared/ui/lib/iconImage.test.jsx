import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Copy, Download } from "lucide-react";
import IconImage from "../components/ui/IconImage.jsx";
import IconActions from "../components/ui/IconActions.jsx";
import { iconImageUrl } from "./iconImage.js";

afterEach(() => {
  document.documentElement.style.removeProperty("--primary");
  document.documentElement.style.removeProperty("--secondary");
});

describe("iconImageUrl", () => {
  it("draws the lucide icon's own shapes in the given color", () => {
    const url = iconImageUrl(Download, "#123abc");
    const svg = decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).toContain('stroke="#123abc"');
    expect(svg).toContain('d="M12 15V3"');
    expect(svg).not.toContain("key=");
    expect(iconImageUrl(Download, "#123abc")).toBe(url);
  });

  it("refuses colors that are not plain color values", () => {
    expect(iconImageUrl(Download, 'red" onload="x')).toBeNull();
    expect(iconImageUrl(Download, null)).toBeNull();
  });

  it("refuses components that are not lucide icons", () => {
    expect(iconImageUrl(() => null, "#000000")).toBeNull();
  });
});

describe("IconImage", () => {
  it("is a hidden image span with a color, and the normal svg without one", () => {
    const { container, rerender } = render(<IconImage icon={Copy} size={14} color="#ffffff" />);
    const span = container.querySelector("[data-icon-image]");
    expect(span).toHaveAttribute("aria-hidden", "true");
    expect(span.style.width).toBe("14px");
    expect(container.querySelector("svg")).toBeNull();
    rerender(<IconImage icon={Copy} size={14} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("IconActions icons", () => {
  it("follow the theme color of their backdrop and switch when it changes", async () => {
    document.documentElement.style.setProperty("--primary", "#ffffff");
    document.documentElement.style.setProperty("--secondary", "#000000");
    render(
      <MemoryRouter>
        <IconActions surface="secondary" actions={[{ key: "copy", label: "Copy", aria: "Copy a.txt", icon: Copy, run: () => {} }]} />
      </MemoryRouter>,
    );
    const button = screen.getByRole("button", { name: "Copy a.txt" });
    // Ghost on a card: text-primary, so the icon is drawn in --primary.
    expect(button.querySelector("[data-icon-image]").style.backgroundImage).toContain(encodeURIComponent("#ffffff"));
    await act(async () => {
      document.documentElement.style.setProperty("--primary", "#000000");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button.querySelector("[data-icon-image]").style.backgroundImage).toContain(encodeURIComponent("#000000"));
  });
});
