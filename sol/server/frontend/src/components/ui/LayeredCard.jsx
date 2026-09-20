import { cloneElement } from "react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/**
 * LayeredCard — LayeredPill's vertical sibling (same layered grammar, stacked).
 *
 * Accent card track (rounded-large-element) with a primary surface inset at
 * the top; its rounded corners line up with the frame and seam against the
 * accent action row below. Two sizes:
 *
 *  - `size="sm"` — compact button-style strip (pill-like, text-xs). Used where
 *    a LayeredPill would go but stacked, e.g. narrow columns.
 *  - `size="md"` — actual content display: roomier body for an icon/title/
 *    description (wrap content in `flex-1 min-w-0` blocks), action row below.
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
 *     icon={<Database size={16} />}
 *     actionLabel="Manage"
 *     onAction={() => setOpen(true)}
 *   >
 *     <div className="flex-1 min-w-0">
 *       <h3 className="font-mono text-sm">Backups</h3>
 *       <p className="text-xs text-accent mt-0.5">Last backup 2h ago</p>
 *     </div>
 *   </LayeredCard>
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
 *   size?: "sm" | "md",
 *   className?: string,
 * }} props
 */
export default function LayeredCard({
  icon,
  children,
  actionIcon,
  actionLabel,
  onAction,
  actionDisabled = false,
  actionAriaLabel,
  actionRef,
  mono = false,
  size = "sm",
  className,
}) {
  const compact = size !== "md";
  const chipIcon = icon
    ? cloneElement(icon, { className: cn("text-accent shrink-0", icon.props?.className) })
    : null;
  const btnIcon = actionIcon
    ? cloneElement(actionIcon, { className: cn("shrink-0", actionIcon.props?.className) })
    : null;
  return (
    <div
      className={cn(
        "inline-flex max-w-full flex-col items-stretch rounded-large-element bg-accent text-primary border border-accent/40",
        compact ? "text-xs" : "text-sm",
        className,
      )}
    >
      <div
        className={cn(
          "bg-primary text-secondary",
          compact
            ? "flex items-center gap-1.5 rounded-pill px-3 py-2 m-1.5 mb-0.5"
            : "flex items-start gap-2.5 rounded-large-element p-4",
          mono && "font-mono",
        )}
      >
        {chipIcon} {children}
      </div>
      {onAction ? (
        <button
          ref={actionRef}
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          aria-label={actionAriaLabel}
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-large-element text-primary",
            compact ? "px-3 pt-1 pb-2 text-xs" : "px-4 pt-1 pb-2 text-sm",
            mono && "font-mono",
            "cursor-pointer enabled:hover:underline underline-offset-2 motion-safe:transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {btnIcon} {actionLabel}
        </button>
      ) : (
        <span
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-large-element text-primary",
            compact ? "px-3 pt-1 pb-2 text-xs" : "px-4 pt-1 pb-2 text-sm",
            mono && "font-mono",
          )}
        >
          {btnIcon} {actionLabel}
        </span>
      )}
    </div>
  );
}

LayeredCard.propTypes = {
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
  size: PropTypes.oneOf(["sm", "md"]),
  className: PropTypes.string,
};