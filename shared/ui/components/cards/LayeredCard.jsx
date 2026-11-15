import { cloneElement } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";
import { haptic } from "../../utils/haptics.js";

/**
 * LayeredCard — LayeredPill's vertical sibling (same layered grammar, stacked).
 *
 * A tray (secondary surface) with a primary-surface panel inset at the top, and
 * the tray's foot as the action band. The band belongs to the tray, not to the
 * panel: the card's one action always sits in the same place, at the same
 * height, whatever the panel above it holds. A band with no `actionLabel` is
 * empty on purpose — that is a state, not a missing button — so a column of
 * cards keeps one rhythm instead of sprouting buttons that do not apply.
 *
 * Two sizes:
 *
 *  - `size="sm"` — compact strip (pill-like panel, text-xs), for narrow columns
 *    where a LayeredPill would go but stacked.
 *  - `size="md"` — a content card: panel header (icon, title, headerActions),
 *    a roomy body, and a full-height band with the label at the left and an
 *    optional trailing affordance (an arrow disc, a count) at the right.
 *
 * The band is a <button> by default. Pass `actionAs` and `actionProps` to make
 * it a link — `actionAs={Link} actionProps={{ to }}` — or any other element.
 * The band carries `group`, so a trailing node can move on hover
 * (`group-hover:translate-x-1`).
 *
 * Usage (compact):
 *   <LayeredCard
 *     size="sm"
 *     icon={<Mail size={12} />}
 *     actionIcon={<RotateCw size={11} />}
 *     actionLabel="Resend"
 *     onAction={onResend}
 *   >
 *     Code sent to {email}
 *   </LayeredCard>
 *
 * Usage (content):
 *   <LayeredCard
 *     size="md"
 *     icon={<Database size={18} />}
 *     title="Backups"
 *     headerActions={<Pill>Ready</Pill>}
 *     actionLabel="Open"
 *     actionTrailing={<ArrowDisc />}
 *     actionAs={Link}
 *     actionProps={{ to: "/backups" }}
 *   >
 *     <p>Last backup 2h ago</p>
 *   </LayeredCard>
 *
 * @param {{
 *   icon?: React.ReactElement,
 *   title?: React.ReactNode,
 *   headerActions?: React.ReactNode,
 *   children: React.ReactNode,
 *   actionLabel?: React.ReactNode,
 *   actionIcon?: React.ReactElement,
 *   actionTrailing?: React.ReactNode,
 *   onAction?: (event: React.MouseEvent) => void,
 *   actionAs?: React.ElementType,
 *   actionProps?: Record<string, any>,
 *   actionDisabled?: boolean,
 *   actionAriaLabel?: string,
 *   actionRef?: React.Ref<HTMLElement>,
 *   mono?: boolean,
 *   size?: "sm" | "md",
 *   fullWidth?: boolean,
 *   className?: string,
 * }} props
 */
export default function LayeredCard({
  icon,
  title,
  headerActions,
  children,
  actionLabel,
  actionIcon,
  actionTrailing,
  onAction,
  actionAs,
  actionProps,
  actionDisabled = false,
  actionAriaLabel,
  actionRef,
  mono = false,
  size = "sm",
  fullWidth = false,
  className,
}) {
  const compact = size !== "md";
  const chipIcon = icon
    ? cloneElement(icon, { className: cn("shrink-0", icon.props?.className) })
    : null;
  const btnIcon = actionIcon
    ? cloneElement(actionIcon, { className: cn("shrink-0", actionIcon.props?.className) })
    : null;

  const hasAction = actionLabel != null && actionLabel !== "";
  const As = actionAs || "button";
  const isButton = As === "button";
  const interactive = !isButton || Boolean(onAction);
  const hasHeader = Boolean(title || chipIcon);

  const bandClassName = cn(
    "group flex w-full items-center justify-between gap-3",
    compact ? "px-3 pt-1 pb-2 text-xs" : "min-h-14 px-6 py-2.5 text-base",
    mono && "font-mono",
    interactive && "cursor-pointer",
    // The compact strip is a text action, so it underlines like one. A content
    // card's band is a surface: its trailing affordance carries the hover.
    compact && interactive && "enabled:hover:underline underline-offset-2",
    actionDisabled && "opacity-50 pointer-events-none",
  );

  const bandContent = (
    <>
      <span className={cn("flex min-w-0 items-center gap-1.5", mono && "font-mono")}>
        {btnIcon} {actionLabel}
      </span>
      {actionTrailing}
    </>
  );

  let band = null;
  if (hasAction) {
    band = interactive ? (
      <As
        ref={actionRef}
        {...(isButton ? { type: "button", disabled: actionDisabled } : {})}
        aria-label={actionAriaLabel}
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
        className={cn(bandClassName, actionProps?.className)}
      >
        {bandContent}
      </As>
    ) : (
      <span className={bandClassName}>{bandContent}</span>
    );
  }

  return (
    <div
      className={cn(
        "flex-col items-stretch rounded-large-element surface-secondary",
        fullWidth ? "flex w-full" : "inline-flex max-w-full",
        className,
      )}
    >
      <div className={cn("flex-1", compact ? "p-1.5 pb-0.5" : "p-2")}>
        {compact ? (
          <div
            className={cn(
              "surface-primary flex items-center gap-1.5 rounded-pill px-3 py-2",
              mono && "font-mono",
            )}
          >
            {chipIcon} {children}
          </div>
        ) : (
          <div className="surface-primary rounded-[calc(var(--radius-large-element)-0.5rem)]">
            {hasHeader && (
              <div className="flex items-center justify-between gap-3 border-b border-secondary/10 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  {chipIcon}
                  {/* surface-scan: ignore-next-line -- card title, mono is the heading face */}
                  {title && <h2 className="truncate font-mono font-normal">{title}</h2>}
                </div>
                {headerActions && (
                  <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
                )}
              </div>
            )}
            <div className="p-5">{children}</div>
          </div>
        )}
      </div>
      {band}
    </div>
  );
}

LayeredCard.propTypes = {
  icon: PropTypes.element,
  title: PropTypes.node,
  headerActions: PropTypes.node,
  children: PropTypes.node.isRequired,
  actionLabel: PropTypes.node,
  actionIcon: PropTypes.element,
  actionTrailing: PropTypes.node,
  onAction: PropTypes.func,
  actionAs: PropTypes.elementType,
  actionProps: PropTypes.object,
  actionDisabled: PropTypes.bool,
  actionAriaLabel: PropTypes.string,
  actionRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.elementType }),
  ]),
  mono: PropTypes.bool,
  size: PropTypes.oneOf(["sm", "md"]),
  fullWidth: PropTypes.bool,
  className: PropTypes.string,
};
