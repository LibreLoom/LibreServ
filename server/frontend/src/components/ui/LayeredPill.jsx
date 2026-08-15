import { cloneElement } from "react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/**
 * LayeredPill — the dual-layer segmented pill (settled format, do not deviate).
 *
 * Outer accent track with an inset primary chip; the trailing segment is an
 * action button (when `onAction` is given) or static text (when not). Each
 * segment sizes to its own content; the wrap container keeps them on one line
 * unless there's no space, then the whole pill expands to two lines.
 *
 * The trailing segment is ALWAYS mounted and animates its width in/out
 * (grid-template-columns 0fr → 1fr + opacity). When `actionLabel` is null the
 * segment collapses to zero width instead of unmounting, so content that
 * arrives later (usage figures, statuses fetched after mount) grows the pill
 * smoothly instead of snapping.
 *
 * Usage (email code verification):
 *   <LayeredPill
 *     icon={<Mail size={12} />}
 *     actionIcon={<RotateCw size={11} />}
 *     actionLabel={cooldown > 0 ? `Resend (${cooldown}s)` : "Resend"}
 *     onAction={onResend}
 *     actionDisabled={cooldown > 0}
 *   >
 *     Code sent to {email}
 *   </LayeredPill>
 *
 * @param {{
 *   icon?: React.ReactElement,
 *   children: React.ReactNode,
 *   actionIcon?: React.ReactElement,
 *   actionLabel?: React.ReactNode,  // null/undefined → collapsed trailing segment
 *   onAction?: () => void,
 *   actionDisabled?: boolean,
 *   actionAriaLabel?: string,
 *   actionRef?: React.Ref<HTMLButtonElement>,
 *   mono?: boolean,
 *   title?: string,
 *   className?: string,
 * }} props
 */
export default function LayeredPill({
  icon,
  children,
  actionIcon,
  actionLabel,
  onAction,
  actionDisabled = false,
  actionAriaLabel,
  actionRef,
  mono = false,
  title,
  className,
}) {
  const chipIcon = icon
    ? cloneElement(icon, { className: cn("text-accent shrink-0", icon.props?.className) })
    : null;
  const btnIcon = actionIcon
    ? cloneElement(actionIcon, { className: cn("shrink-0", actionIcon.props?.className) })
    : null;
  const segmentBase = cn(
    "flex items-center gap-1 whitespace-nowrap text-xs py-1.5 pl-2.5 pr-3 rounded-r-pill text-primary",
    mono && "font-mono",
  );
  const hasAction = actionLabel != null && actionLabel !== "";
  return (
    <div
      title={title}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center rounded-pill bg-accent text-primary text-xs border border-accent/40",
        className,
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap bg-primary text-secondary rounded-pill py-1.5 pl-3 pr-2.5",
          mono && "font-mono",
        )}
      >
        {chipIcon} {children}
      </span>
      {/* Trailing segment — always mounted; collapses via the grid-track
          trick (grid-template-columns 0fr → 1fr) so content arriving later
          grows the pill smoothly instead of snapping. shrink-0 preserves the
          wrap-to-two-lines behavior when the pill has no room. */}
      <span
        aria-hidden={!hasAction}
        className={cn(
          "grid shrink-0 min-w-0 overflow-hidden",
          "motion-safe:transition-[grid-template-columns,opacity] motion-safe:duration-300",
          "motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
          hasAction ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0",
        )}
      >
        <span className="min-w-0 overflow-hidden">
          {onAction && hasAction ? (
            <button
              ref={actionRef}
              type="button"
              onClick={onAction}
              disabled={actionDisabled}
              aria-label={actionAriaLabel}
              className={cn(
                segmentBase,
                "enabled:hover:underline underline-offset-2 motion-safe:transition-colors disabled:opacity-50",
              )}
            >
              {btnIcon} {actionLabel}
            </button>
          ) : (
            <span className={segmentBase}>{btnIcon} {actionLabel}</span>
          )}
        </span>
      </span>
    </div>
  );
}

LayeredPill.propTypes = {
  icon: PropTypes.element,
  children: PropTypes.node.isRequired,
  actionIcon: PropTypes.element,
  actionLabel: PropTypes.node,
  onAction: PropTypes.func,
  actionDisabled: PropTypes.bool,
  actionAriaLabel: PropTypes.string,
  actionRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.elementType }),
  ]),
  mono: PropTypes.bool,
  title: PropTypes.string,
  className: PropTypes.string,
};