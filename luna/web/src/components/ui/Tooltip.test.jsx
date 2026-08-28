import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoHint, TermHint, Tooltip, ActionTooltipGroup } from "./Tooltip";

describe("InfoHint", () => {
  it("opens a longer explanation on click and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <InfoHint
        delayMs={0}
        label="What Admin means"
        content="An admin can add users, change settings, and manage this Luna."
      />,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(screen.getByRole("button", { name: /What Admin means/i }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/An admin can add users/i);
    expect(tip.className).toMatch(/bg-secondary/);
    expect(tip.className).toMatch(/text-primary/);
    expect(tip.className).toMatch(/rounded-large-element/);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("TermHint", () => {
  it("opens a smaller popup for a wrapped word", async () => {
    const user = userEvent.setup();
    render(
      <p>
        Plug Luna into your{" "}
        <TermHint delayMs={0} content="The box that brings internet into the house.">
          router
        </TermHint>
        .
      </p>,
    );
    await user.click(screen.getByRole("button", { name: "router" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/brings internet into the house/i);
    expect(tip.className).toMatch(/rounded-pill/);
    expect(tip.className).toMatch(/bg-secondary/);
    expect(tip.className).toMatch(/text-primary/);
  });
});

describe("Tooltip + ActionTooltipGroup", () => {
  it("shows a short label on hover without blocking the button click", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button" aria-label="Copy note.txt" onClick={onCopy}>
          copy-icon
        </button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: /Copy note/i }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
    await user.click(screen.getByRole("button", { name: /Copy note/i }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("waits on the first icon, then opens siblings immediately", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ActionTooltipGroup delayMs={400} leaveGraceMs={300}>
        <div>
          <Tooltip content="Copy">
            <button type="button">Copy</button>
          </Tooltip>
          <Tooltip content="Move">
            <button type="button">Move</button>
          </Tooltip>
        </div>
      </ActionTooltipGroup>,
    );

    await user.hover(screen.getByRole("button", { name: "Copy" }));
    expect(screen.queryByRole("tooltip")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    await user.hover(screen.getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move");

    vi.useRealTimers();
  });
});
