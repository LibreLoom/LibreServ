import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoHint, TermHint } from "./Tooltip";

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
    expect(tip.className).toMatch(/tooltip-pop-in/);
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
    expect(tip.className).toMatch(/tooltip-pop-in/);
  });
});
