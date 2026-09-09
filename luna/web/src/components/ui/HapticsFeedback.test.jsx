import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CardButton from "./CardButton.jsx";
import { InfoHint } from "./Tooltip.jsx";
import CollapsibleSection from "../common/CollapsibleSection.jsx";
import TextLink from "./TextLink.jsx";
import LayeredPill from "./LayeredPill.jsx";
import ConfirmModal from "../cards/ConfirmModal.jsx";
import * as haptics from "../../utils/haptics.js";

describe("UI Haptic Feedback Integration", () => {
  let hapticSpy;

  beforeEach(() => {
    hapticSpy = vi.spyOn(haptics, "haptic").mockImplementation(() => {});
  });

  afterEach(() => {
    hapticSpy.mockRestore();
  });

  it("CardButton emits variant-specific haptic feedback on click", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <CardButton actionLabel="Click me" onClick={onClick} />
    );

    fireEvent.click(screen.getByRole("button", { name: /Click me/i }));
    expect(hapticSpy).toHaveBeenCalledWith("medium");

    hapticSpy.mockClear();
    rerender(
      <CardButton actionLabel="Delete item" variant="danger" onClick={onClick} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete item/i }));
    expect(hapticSpy).toHaveBeenCalledWith("error");

    hapticSpy.mockClear();
    rerender(
      <CardButton actionLabel="Nav option" variant="nav" onClick={onClick} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Nav option/i }));
    expect(hapticSpy).toHaveBeenCalledWith("selection");
  });

  it("InfoHint emits light haptic when clicked", () => {
    render(<InfoHint content="Helpful explanation" />);
    const btn = screen.getByRole("button", { name: /More about this/i });
    fireEvent.click(btn);
    expect(hapticSpy).toHaveBeenCalledWith("light");
  });

  it("CollapsibleSection emits light haptic on accordion toggle", () => {
    render(
      <CollapsibleSection title="Advanced details">
        <p>Secret contents</p>
      </CollapsibleSection>
    );
    const trigger = screen.getByRole("button", { name: /Advanced details/i });
    fireEvent.click(trigger);
    expect(hapticSpy).toHaveBeenCalledWith("light");
  });

  it("TextLink emits light haptic on navigation click", () => {
    render(
      <MemoryRouter>
        <TextLink to="/settings">Go to settings</TextLink>
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: /Go to settings/i });
    fireEvent.click(link);
    expect(hapticSpy).toHaveBeenCalledWith("light");
  });

  it("LayeredPill emits light haptic when clicking action button", () => {
    const onAction = vi.fn();
    render(
      <LayeredPill
        actionLabel="Start"
        onAction={onAction}
      >
        Backup
      </LayeredPill>
    );
    const actionBtn = screen.getByRole("button", { name: /Start/i });
    fireEvent.click(actionBtn);
    expect(hapticSpy).toHaveBeenCalledWith("light");
    expect(onAction).toHaveBeenCalled();
  });

  it("ConfirmModal emits warning haptic when dangerous modal opens", () => {
    const { rerender } = render(
      <ConfirmModal
        open={false}
        title="Delete drive?"
        variant="danger"
      />
    );
    expect(hapticSpy).not.toHaveBeenCalled();

    rerender(
      <ConfirmModal
        open={true}
        title="Delete drive?"
        variant="danger"
      />
    );
    expect(hapticSpy).toHaveBeenCalledWith("warning");
  });

  it("Button emits variant-specific haptic patterns and respects haptic prop", async () => {
    const { default: Button } = await import("./Button.jsx");
    const { rerender } = render(<Button>Standard</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Standard" }));
    expect(hapticSpy).toHaveBeenCalledWith("medium");

    hapticSpy.mockClear();
    rerender(<Button variant="ghost">Ghost action</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Ghost action" }));
    expect(hapticSpy).toHaveBeenCalledWith("light");

    hapticSpy.mockClear();
    rerender(<Button variant="outline">Outline action</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Outline action" }));
    expect(hapticSpy).toHaveBeenCalledWith("light");

    hapticSpy.mockClear();
    rerender(<Button variant="accent">Accent submit</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Accent submit" }));
    expect(hapticSpy).toHaveBeenCalledWith("heavy");

    hapticSpy.mockClear();
    rerender(<Button variant="danger">Delete</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(hapticSpy).toHaveBeenCalledWith("error");

    hapticSpy.mockClear();
    rerender(<Button variant="danger" haptic="warning">Confirm Warning</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Warning" }));
    expect(hapticSpy).toHaveBeenCalledWith("warning");
  });

  it("ModalCard emits medium haptic on presentation and supports openHaptic suppression", async () => {
    const { default: ModalCard } = await import("../cards/ModalCard.jsx");
    const { rerender } = render(
      <ModalCard open={false} title="Test Modal">
        <p>Modal content</p>
      </ModalCard>
    );
    expect(hapticSpy).not.toHaveBeenCalled();

    rerender(
      <ModalCard open={true} title="Test Modal">
        <p>Modal content</p>
      </ModalCard>
    );
    expect(hapticSpy).toHaveBeenCalledWith("medium");

    hapticSpy.mockClear();
    rerender(
      <ModalCard open={true} openHaptic={false} title="Suppressed Modal">
        <p>Modal content</p>
      </ModalCard>
    );
    expect(hapticSpy).not.toHaveBeenCalled();
  });

  it("Dropdown emits light haptic when toggling open", async () => {
    const { default: Dropdown } = await import("../common/Dropdown.jsx");
    render(
      <Dropdown
        options={[{ value: "1", label: "One" }]}
        value="1"
        onChange={() => {}}
      />
    );
    const trigger = screen.getByRole("button", { name: /One/i });
    fireEvent.click(trigger);
    expect(hapticSpy).toHaveBeenCalledWith("light");
  });

  it("Callout emits light haptic when dismissed", async () => {
    const { default: Callout } = await import("../common/Callout.jsx");
    const onDismiss = vi.fn();
    render(
      <Callout title="Heads up" onDismiss={onDismiss}>
        Notification message
      </Callout>
    );
    const dismissBtn = screen.getByRole("button", { name: /Dismiss/i });
    fireEvent.click(dismissBtn);
    expect(hapticSpy).toHaveBeenCalledWith("light");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("ModalCard close button emits light haptic when clicked", async () => {
    const { default: ModalCard } = await import("../cards/ModalCard.jsx");
    const onClose = vi.fn();
    render(
      <ModalCard open={true} onClose={onClose} title="Dismissable Modal">
        <p>Modal content</p>
      </ModalCard>
    );
    const closeBtn = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeBtn);
    expect(hapticSpy).toHaveBeenCalledWith("light");
  });
});
