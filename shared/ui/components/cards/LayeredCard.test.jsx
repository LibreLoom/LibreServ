import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Mail } from "lucide-react";
import LayeredCard from "./LayeredCard.jsx";

describe("LayeredCard", () => {
  it("puts the identity on the band and the content in the panel", () => {
    render(
      <LayeredCard
        icon={<Mail size={18} />}
        title="Backups"
        panelActions={<span>Ready</span>}
        actionLabel="Open Backups"
        onAction={() => {}}
      >
        <div>Last backup 2h ago</div>
      </LayeredCard>,
    );
    expect(screen.getByRole("heading", { name: "Backups" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Last backup 2h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Backups" })).toBeEnabled();
  });

  it("calls onAction when the disc is pressed", () => {
    const onAction = vi.fn();
    render(
      <LayeredCard title="Media" actionLabel="Open Media" onAction={onAction}>
        <div>1.2 TB free</div>
      </LayeredCard>,
    );
    screen.getByRole("button", { name: "Open Media" }).click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("does not fire while the action is disabled", () => {
    const onAction = vi.fn();
    render(
      <LayeredCard title="Media" actionLabel="Open Media" onAction={onAction} actionDisabled>
        <div>1.2 TB free</div>
      </LayeredCard>,
    );
    const disc = screen.getByRole("button", { name: "Open Media" });
    expect(disc).toBeDisabled();
    disc.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("makes the disc a link when actionAs and actionProps are given", () => {
    const onClick = vi.fn();
    render(
      <LayeredCard
        title="Media"
        actionLabel="Open Media"
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
    const link = screen.getByRole("link", { name: "Open Media" });
    expect(link).toHaveAttribute("href", "/files/d1");
    link.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves the disc out entirely when there is no action", () => {
    render(
      <LayeredCard title="Media">
        <div>Unplugged. Plug it back in to use its files.</div>
      </LayeredCard>,
    );
    expect(screen.getByRole("heading", { name: "Media" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("makes the rest of the band do what the button does, without a second control", () => {
    const onAction = vi.fn();
    const { container } = render(
      <LayeredCard title="Media" actionLabel="Open" onAction={onAction}>
        <div>1.2 TB free</div>
      </LayeredCard>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const target = container.querySelector("[data-slot=band-target]");
    expect(target).toHaveAttribute("aria-hidden", "true");
    expect(target).toHaveAttribute("tabindex", "-1");
    fireEvent.click(target);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("keeps panel actions outside the band's target", () => {
    const { container } = render(
      <LayeredCard title="Media" panelActions={<button type="button">Menu</button>} actionLabel="Open" onAction={() => {}}>
        <div>1.2 TB free</div>
      </LayeredCard>,
    );
    const target = container.querySelector("[data-slot=band-target]");
    expect(target).not.toContainElement(screen.getByRole("button", { name: "Menu" }));
  });

  it("has no band target while the action is disabled", () => {
    const { container } = render(
      <LayeredCard title="Media" actionLabel="Open" onAction={() => {}} actionDisabled>
        <div>x</div>
      </LayeredCard>,
    );
    expect(container.querySelector("[data-slot=band-target]")).toBeNull();
  });
});
