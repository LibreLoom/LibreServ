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