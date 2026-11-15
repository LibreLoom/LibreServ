import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Mail } from "lucide-react";
import LayeredCard from "./LayeredCard.jsx";

describe("LayeredCard", () => {
  it("renders panel content and a button action when onAction is given", () => {
    const onAction = vi.fn();
    render(
      <LayeredCard
        icon={<Mail size={12} />}
        actionIcon={<Mail size={11} />}
        actionLabel="Resend (30s)"
        onAction={onAction}
        actionDisabled
        actionAriaLabel="Send a new code"
      >
        Code sent to you@example.com
      </LayeredCard>,
    );
    expect(screen.getByText("Code sent to you@example.com")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Send a new code" });
    expect(btn).toBeDisabled();
    btn.click();
    expect(onAction).not.toHaveBeenCalled(); // disabled
  });

  it("renders a static span action when onAction is omitted", () => {
    render(<LayeredCard actionLabel="12.4 GB / 20 GB">Included: Backup</LayeredCard>);
    expect(screen.getByText("Included: Backup")).toBeInTheDocument();
    expect(screen.getByText("12.4 GB / 20 GB")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders content in md size with a header and the action band", () => {
    render(
      <LayeredCard
        size="md"
        icon={<Mail size={18} />}
        title="Backups"
        headerActions={<span>Ready</span>}
        actionLabel="Open"
        actionTrailing={<span data-testid="trailing" />}
        onAction={() => {}}
      >
        <div>Last backup 2h ago</div>
      </LayeredCard>,
    );
    expect(screen.getByRole("heading", { name: "Backups" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Last backup 2h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    expect(screen.getByTestId("trailing")).toBeInTheDocument();
  });

  it("makes the band a link when actionAs and actionProps are given", () => {
    const onClick = vi.fn();
    render(
      <LayeredCard
        size="md"
        title="Media"
        actionLabel="Open"
        actionAs="a"
        actionProps={{
          href: "/files/d1",
          onClick: (event) => {
            event.preventDefault();
            onClick();
          },
        }}
      >
        <div>1.2 TB free</div>
      </LayeredCard>,
    );
    const link = screen.getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "/files/d1");
    link.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves the band out entirely when there is no action", () => {
    const { container } = render(
      <LayeredCard size="md" title="Media">
        <div>Unplugged. Plug it back in to use its files.</div>
      </LayeredCard>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    // Panel only: the tray's foot is empty, not a disabled button.
    expect(container.querySelector(".min-h-14")).toBeNull();
  });
});
