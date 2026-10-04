import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
    expect(tip.className).toMatch(/surface-secondary/);
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
    expect(tip.className).toMatch(/rounded-large-element/);
    expect(tip.className).toMatch(/surface-secondary/);
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
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Copy");
    expect(tip.className).toMatch(/rounded-large-element/);
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

  it("opens only while the pointer is actively over that button", async () => {
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

    const copyBtn = screen.getByRole("button", { name: "Copy" });
    const moveBtn = screen.getByRole("button", { name: "Move" });

    await user.hover(copyBtn);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    await user.unhover(copyBtn);
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(moveBtn);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move");
    expect(screen.queryByRole("tooltip")).not.toHaveTextContent("Copy");

    vi.useRealTimers();
  });

  it("aborts a pending hover open when the pointer leaves during the delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <Tooltip delayMs={400} content="Copy">
        <button type="button">Copy</button>
      </Tooltip>,
    );

    const btn = screen.getByRole("button", { name: "Copy" });
    await user.hover(btn);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.unhover(btn);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    vi.useRealTimers();
  });

  it("resumes hover after click when the pointer never left the button", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button" aria-label="Copy note.txt" onClick={onCopy}>
          copy-icon
        </button>
      </Tooltip>,
    );

    const btn = screen.getByRole("button", { name: /Copy note/i });
    await user.hover(btn);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    await user.click(btn);
    expect(onCopy).toHaveBeenCalledTimes(1);
    // Click hides then re-arms from active hover (pointer still inside).
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
  });
});

describe("Tooltip leak guards", () => {
  it("closes when pointerleave is missed and the pointer moves elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Tooltip delayMs={0} content="Copy">
          <button type="button">Copy</button>
        </Tooltip>
        <p>elsewhere</p>
      </div>,
    );
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();

    // No pointerleave on the button, as when a modal covers it.
    fireEvent.pointerMove(screen.getByText("elsewhere"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes a hover hint when pointerleave is missed too", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoHint delayMs={0} label="About" content="Details" />
        <p>elsewhere</p>
      </div>,
    );
    await user.hover(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerMove(screen.getByText("elsewhere"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps a clicked (pinned) hint open when the pointer moves away", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoHint delayMs={0} label="About" content="Details" />
        <p>elsewhere</p>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerMove(screen.getByText("elsewhere"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("closes when the window loses focus", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("never has two popups open at once", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoHint delayMs={0} label="About" content="Details" />
        <Tooltip delayMs={0} content="Copy">
          <button type="button">Copy</button>
        </Tooltip>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findAllByRole("tooltip")).toHaveLength(1);
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    await screen.findByText("Copy", { selector: '[role="tooltip"]' });
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy");
  });

  it("shows on keyboard focus again after Tab away and Shift+Tab back", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoHint delayMs={0} label="About" content="Details" />
        <button type="button">next</button>
      </div>,
    );
    await user.tab();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab({ shift: true });
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("does not open from mouse focus", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    const btn = screen.getByRole("button", { name: "Copy" });
    await user.pointer({ keys: "[MouseLeft>]", target: btn });
    act(() => btn.focus());
    await user.pointer({ keys: "[/MouseLeft]" });
    await user.unhover(btn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("ignores touch hover", async () => {
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Copy" }), { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("releases the group when the open tooltip unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    function Row({ showCopy }) {
      return (
        <ActionTooltipGroup delayMs={400} leaveGraceMs={300}>
          {showCopy && (
            <Tooltip content="Copy">
              <button type="button">Copy</button>
            </Tooltip>
          )}
          <Tooltip content="Move">
            <button type="button">Move</button>
          </Tooltip>
        </ActionTooltipGroup>
      );
    }
    const { rerender } = render(<Row showCopy />);
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    rerender(<Row showCopy={false} />);
    await act(async () => {
      vi.advanceTimersByTime(400); // past the grace window: group is cold again
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(screen.getByRole("button", { name: "Move" }));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole("tooltip")).toBeNull(); // waits the full delay again
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move");
    vi.useRealTimers();
  });

  it("draws popups above modals and lightboxes", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip delayMs={0} content="Copy">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    expect((await screen.findByRole("tooltip")).className).toMatch(/z-\[3000\]/);
  });
});

describe("hint fade", () => {
  it("fades the popup in, then fades it out before removing it", async () => {
    const user = userEvent.setup();
    render(<InfoHint delayMs={0} label="What Admin means" content="Admins manage this Luna." />);
    await user.click(screen.getByRole("button", { name: /What Admin means/i }));
    const tip = await screen.findByRole("tooltip");
    // Mounts transparent, then fades up on the next frames.
    await vi.waitFor(() => expect(tip.className).toMatch(/opacity-100/));
    expect(tip.className).toMatch(/transition-opacity/);

    await user.keyboard("{Escape}");
    // Fading out: no longer announced as a tooltip, ignores the pointer.
    expect(screen.queryByRole("tooltip")).toBeNull();
    const fading = screen.getByText("Admins manage this Luna.");
    expect(fading).toHaveAttribute("aria-hidden", "true");
    expect(fading.className).toMatch(/opacity-0/);
    expect(fading.className).toMatch(/pointer-events-none/);
    // Then it is removed once the fade has played.
    await vi.waitFor(() => expect(screen.queryByText("Admins manage this Luna.")).toBeNull());
  });
});
