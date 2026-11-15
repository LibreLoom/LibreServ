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
 * The band itself is not a button — a status pill or an actions menu can live
 * in the panel — so the disc is the target. It carries `actionLabel` as its
 * accessible name, since the arrow has no words of its own.
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
  const interactive = !isButton || Boolean(onAction);

  const discClassName = cn(
    "flex size-9 shrink-0 items-center justify-center rounded-pill surface-primary",
    "motion-safe:transition-[transform,background-color,color,box-shadow] motion-safe:duration-200",
    interactive &&
      "cursor-pointer hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary hover:translate-x-0.5",
    actionDisabled && "opacity-50 pointer-events-none",
    actionProps?.className,
  );

  const disc = actionLabel ? (
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
      className={discClassName}
    >
      <ArrowRight size={ICON_SIZE.md} aria-hidden="true" />
    </As>
  ) : null;

  return (
    <div
      className={cn(
        "flex w-full flex-col rounded-large-element surface-secondary",
        className,
      )}
    >
      <div className="flex min-h-16 items-center gap-3 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {chipIcon}
          {/* surface-scan: ignore-next-line -- card title, mono is the heading face */}
          {title && <h2 className="truncate font-mono font-normal">{title}</h2>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{disc}</div>
      </div>
      <div className="flex-1 px-2 pb-2">
        <div className="surface-primary h-full rounded-[calc(var(--radius-large-element)-0.5rem)] p-5">
          {panelActions ? (
            <div className="mb-3 flex flex-wrap items-center justify-end gap-2">{panelActions}</div>
          ) : null}
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
