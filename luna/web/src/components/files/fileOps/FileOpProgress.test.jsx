import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import FileOpProgress from "./FileOpProgress.jsx";

describe("FileOpProgress", () => {
  it("shows a measured bar on the page surface", () => {
    render(
      <div className="surface-primary p-3">
        <FileOpProgress pct={42.4} label="Uploading a.txt" />
      </div>,
    );
    const bar = screen.getByRole("progressbar", { name: "Uploading a.txt" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });

  it("shows a measured bar on a card", () => {
    render(
      <div className="surface-secondary p-3">
        <FileOpProgress pct={100} surface="secondary" label="Done" />
      </div>,
    );
    expect(screen.getByRole("progressbar", { name: "Done" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("shows a moving bar when the size is unknown", async () => {
    render(
      <div className="surface-primary p-3">
        <FileOpProgress pct={null} label="Emptying" />
      </div>,
    );
    const bar = await screen.findByRole("progressbar", { name: "Emptying" });
    expect(bar.getAttribute("data-slot")).toBe("linear-progress");
  });
});
