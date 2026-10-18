import { cn } from "../../lib/utils.js";

/**
 * A small pill for one fact ("3 versions", "Latest 18 Oct"). Sits on a row (bg-secondary), so it takes the card fill.
 * Wraps to card-like corners when the text needs more than one line.
 * @param {{ icon?: import("react").ElementType, children: import("react").ReactNode, className?: string }} props
 */
export function Chip({ icon: Icon, children, className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip border border-border bg-card px-2.5 py-0.5 text-xs text-foreground",
        className,
      )}
    >
      {Icon ? <Icon className="size-3 shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Round icon badge at the start of a row. */
export function RowIcon({ icon: Icon }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-card" aria-hidden="true">
      <Icon className="size-4" />
    </span>
  );
}

/** Row surface shared by every list in the viewer: an inset on a card. */
export const ROW_CLASS = "rounded-large-element bg-secondary text-secondary-foreground px-4 py-3 flex flex-wrap items-center justify-between gap-3";
