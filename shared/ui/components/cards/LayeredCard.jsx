import { cloneElement } from "react";
import PropTypes from "prop-types";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/utils";
import Button from "../ui/Button.jsx";
import { haptic } from "../../utils/haptics.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

/**
 * LayeredCard — LayeredPill's vertical sibling (same layered grammar, stacked).
 *
 * The tray (secondary surface) carries the card's identity on its top band: the
 * icon and the name, nothing else. The panel below holds the card's contents on
 * the page surface, inset so its corners stay concentric with the tray's, with
 * its top-right corner kept for `panelActions` — the card's state, and whatever
 * acts on it. The band's right end is the card's one action, an "Open →" button:
 * same place, same size, on every card.
 *
 * The band is the drive, the panel is its contents. That is the strongest
 * hierarchy the two surfaces can make, and it keeps the action out of the data.
 *
 * The band's one action is a plain Button — `actionLabel` and an arrow — and the
 * rest of the band does the same thing when pressed, so the card has a large
 * target for its most common action. Only the button reacts to hover. A status
 * pill or actions menu can live in the panel without nesting inside either.
 *
 * Usage:
 *   <LayeredCard
 *     icon={<HardDrive size={18} />}
 *     title="Family photos"
 *     panelActions={<LayeredPill>Ready</LayeredPill>}
 *     actionLabel="Open Family photos"
 *     actionAs={Link}
 *     actionProps={{ to: "/files/d1" }}
 *   >
 *     <p>30 GB free</p>
 *   </LayeredCard>
 *
 * @param {{
 *   icon?: React.ReactElement,
 *   title?: React.ReactNode,
 *   panelActions?: React.ReactNode,
 *   children: React.ReactNode,
 *   actionLabel?: string,
 *   actionAs?: React.ElementType,
 *   actionProps?: Record<string, any>,
 *   onAction?: (event: React.MouseEvent) => void,
 *   actionDisabled?: boolean,
 *   actionRef?: React.Ref<HTMLElement>,
 *   className?: string,
 * }} props
 */
export default function LayeredCard({
  icon,
  title,
  panelActions,
  children,
  actionLabel,
  actionAs,
  actionProps,
  onAction,
  actionDisabled = false,
  actionRef,
  className,
}) {
  const chipIcon = icon
    ? cloneElement(icon, { className: cn("shrink-0", icon.props?.className) })
    : null;

  const As = actionAs || "button";
  const isButton = As === "button";
  const hasAction = Boolean(actionLabel);

  const run = (event) => {
    if (actionDisabled) {
      event.preventDefault();
      return;
    }
    actionProps?.onClick?.(event);
    onAction?.(event);
  };

  // The rest of the band does what the button does, but is not a second
  // control: it is a pointer-only target stretched over the band (out of the tab
  // order and the accessibility tree), so the button stays the one real
  // control. It has no hover style of its own.
  const bandTarget =
    hasAction && !actionDisabled ? (
      <As
        {...(isButton ? { type: "button" } : {})}
        {...actionProps}
        data-slot="band-target"
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => {
          haptic("medium");
          run(event);
        }}
        className={cn("absolute inset-0 cursor-pointer rounded-large-element", actionProps?.className)}
      />
    ) : null;

  // The button's own click (haptic, then `run`) must not be replaced by the
  // caller's onClick, which `run` already calls.
  const buttonProps = { ...actionProps };
  delete buttonProps.onClick;

  const button = hasAction ? (
    <Button asChild size="sm" disabled={actionDisabled} onClick={run} className="relative z-10 ml-auto">
      <As
        ref={actionRef}
        {...(isButton ? { type: "button", disabled: actionDisabled } : {})}
        {...buttonProps}
      >
        {actionLabel}
        <ArrowRight size={ICON_SIZE.sm} aria-hidden="true" />
      </As>
    </Button>
  ) : null;

  return (
    <div
      className={cn(
        "flex w-full flex-col rounded-large-element surface-secondary",
        className,
      )}
    >
      <div className="relative flex min-h-16 items-center gap-3 px-5">
        {bandTarget}
        <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
          {chipIcon}
          {title ? (
            // surface-scan: ignore-next-line -- card title, mono is the heading face
            <h2 className="truncate font-mono font-normal">{title}</h2>
          ) : null}
        </div>
        {button}
      </div>
      <div className="flex-1 px-2 pb-2">
        <div className="surface-primary h-full rounded-[calc(var(--radius-large-element)-0.5rem)] p-5">
          {/* Floated, not stacked: the corner is already empty on every card, so
              the panel's contents keep their place and long first lines wrap
              around the pill instead of running under it. */}
          {panelActions ? <div className="float-right mb-1 ml-3">{panelActions}</div> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

LayeredCard.propTypes = {
  icon: PropTypes.element,
  title: PropTypes.node,
  panelActions: PropTypes.node,
  children: PropTypes.node.isRequired,
  actionLabel: PropTypes.string,
  actionAs: PropTypes.elementType,
  actionProps: PropTypes.object,
  onAction: PropTypes.func,
  actionDisabled: PropTypes.bool,
  actionRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.elementType }),
  ]),
  className: PropTypes.string,
};
