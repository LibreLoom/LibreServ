import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Mail } from "lucide-react";
import LayeredPill from "./LayeredPill.jsx";
import LayeredCard from "./LayeredCard.jsx";

describe.each([
  ["LayeredPill", LayeredPill],
  ["LayeredCard", LayeredCard],
])("%s", (_name, Component) => {
  it("renders chip content and a button action when onAction is given", () => {
    const onAction = vi.fn();
    render(
      <Component
        icon={<Mail size={12} />}
        actionIcon={<Mail size={11} />}
        actionLabel="Resend (30s)"
        onAction={onAction}
        actionDisabled
        actionAriaLabel="Send a new code"
      >
        Code sent to you@example.com
      </Component>,
    );
    expect(screen.getByText("Code sent to you@example.com")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Send a new code" });
    expect(btn).toBeDisabled();
    btn.click();
    expect(onAction).not.toHaveBeenCalled(); // disabled
  });

  it("renders a static span action when onAction is omitted", () => {
    render(<Component actionLabel="12.4 GB / 20 GB">Included: Backup</Component>);
    expect(screen.getByText("Included: Backup")).toBeInTheDocument();
    expect(screen.getByText("12.4 GB / 20 GB")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders content in md size without breaking the action row", () => {
    render(
      <Component size="md" actionLabel="Manage" onAction={() => {}}>
        <div>Backups</div>
      </Component>,
    );
    expect(screen.getByText("Backups")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeEnabled();
  });
});

describe("LayeredPill (collapsible trailing segment)", () => {
  it("collapses the trailing segment when actionLabel is omitted, and expands it when provided", () => {
    const { rerender, container } = render(
      <LayeredPill actionLabel={null}>Included: Backup</LayeredPill>,
    );
    // Collapsed: the trailing grid is hidden from AT and has the 0fr track.
    const trail = container.querySelector('[aria-hidden="true"]');
    expect(trail).not.toBeNull();
    expect(trail.className).toContain("grid-cols-[0fr]");
    expect(trail.className).toContain("opacity-0");

    rerender(<LayeredPill actionLabel="12.4 GB / 20 GB">Included: Backup</LayeredPill>);
    expect(screen.getByText("12.4 GB / 20 GB")).toBeInTheDocument();
    const openTrail = screen.getByText("12.4 GB / 20 GB").closest('[aria-hidden="false"]');
    expect(openTrail).not.toBeNull();
    expect(openTrail.className).toContain("grid-cols-[1fr]");
    expect(openTrail.className).toContain("opacity-100");
  });

  it("keeps the trailing content mounted while collapsed so it can animate open", () => {
    const { container } = render(
      <LayeredPill actionLabel={null}>Included: Backup</LayeredPill>,
    );
    // The wrapper grid exists even when collapsed — the collapse is visual
    // (0fr track + opacity), not a removal.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});