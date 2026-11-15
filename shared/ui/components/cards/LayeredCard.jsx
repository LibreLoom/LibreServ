import { cloneElement } from "react";
import PropTypes from "prop-types";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { haptic } from "../../utils/haptics.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

/**
 * LayeredCard — LayeredPill's vertical sibling (same layered grammar, stacked).
 *
 * The tray (secondary surface) carries the card's identity on its top band: the
 * icon and the name, nothing else. The panel below holds the card's contents on
 * the page surface, inset so its corners stay concentric with the tray's, with
 * its top-right corner kept for `panelActions` — the card's state, and whatever
 * acts on it. The band's right end is the card's one action, the arrow disc:
 * same place, same size, on every card.
 *
 * The band is the drive, the panel is its contents. That is the strongest
 * hierarchy the two surfaces can make, and it keeps the action out of the data.
 *
 * The whole band is the card's one action — a large target for the most common
 * thing to do with the card. A status pill or actions menu can live in the
 * panel without nesting inside it. The arrow is only a picture of the action;
 * `actionLabel` is the accessible name of the band's link or button.
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

  // The whole band is the target, not just the arrow. The link sits over the
  // band as a stretched overlay (the heading stays a real heading, and nothing
  // interactive nests inside anything else); the band's content is pointer-
  // transparent so every tap lands on it. The band is the `group`, so one
  // hover or focus restyles the arrow and the title together.
  const overlay = hasAction ? (
    <As
      ref={actionRef}
      {...(isButton ? { type: "button", disabled: actionDisabled } : {})}
      aria-label={actionLabel}
      {...actionProps}
      onClick={(event) => {
        if (actionDisabled) {
          event.preventDefault();
          return;
        }
        haptic("medium");
        actionProps?.onClick?.(event);
        onAction?.(event);
      }}
      className={cn(
        "absolute inset-0 rounded-large-element",
        actionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        actionProps?.className,
      )}
    />
  ) : null;

  return (
    <div
      className={cn(
        "flex w-full flex-col rounded-large-element surface-secondary",
        className,
      )}
    >
      <div
        className={cn(
          "group relative flex min-h-20 items-center gap-3 px-5",
          actionDisabled && "opacity-50",
        )}
      >
        {overlay}
        <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
          {chipIcon}
          {title ? (
            // surface-scan: ignore-next-line -- card title, mono is the heading face
            <h2
              className={cn(
                "truncate font-mono font-normal",
                hasAction &&
                  !actionDisabled &&
                  "underline decoration-transparent decoration-1 underline-offset-4 motion-safe:transition-[text-decoration-color] group-hover:decoration-current",
              )}
            >
              {title}
            </h2>
          ) : null}
        </div>
        {hasAction ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none ml-auto flex size-9 shrink-0 items-center justify-center rounded-pill surface-primary",
              "motion-safe:transition-transform motion-safe:duration-200",
              !actionDisabled && "group-hover:translate-x-0.5 group-active:translate-x-1",
            )}
          >
            <ArrowRight size={ICON_SIZE.md} />
          </span>
        ) : null}
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
