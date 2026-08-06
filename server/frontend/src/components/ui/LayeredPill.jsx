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
 *   actionLabel: React.ReactNode,
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
      {onAction ? (
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
    </div>
  );
}

LayeredPill.propTypes = {
  icon: PropTypes.element,
  children: PropTypes.node.isRequired,
  actionIcon: PropTypes.element,
  actionLabel: PropTypes.node.isRequired,
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