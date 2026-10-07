import { useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { cn } from "../../lib/utils.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { haptic } from "../../utils/haptics.js";
import { activeChild, useGroupTarget } from "../../hooks/useNavGroup.js";
import { useHoverIntent } from "../../hooks/useHoverIntent.js";
import { useSlidingIndicator } from "../../hooks/useSlidingIndicator.js";
import Unfold from "./Unfold.jsx";

/** @typedef {import("../../hooks/useNavGroup").NavGroupItem} NavGroupItem */

/**
 * Desktop: a normal nav pill — shown as selected while you are on one of its
 * sub-pages — that unfolds its sub-pages in place while you hover or focus
 * it, with a puck that springs to whichever sub-page is open.
 *
 * Built from shared pieces so nothing here is tuned by hand: hover timing is
 * `useHoverIntent` (HOVER_INTENT tokens), the reveal is `Unfold`, the puck is
 * `useSlidingIndicator`, and motion uses the CSS motion tokens.
 *
 * @param {{ group: NavGroupItem, closedClassName: string, keyShortcut?: string }} props
 */
export function DesktopNavGroup({ group, closedClassName, keyShortcut }) {
  const { pathname } = useLocation();
  const current = activeChild(group, pathname);
  const target = useGroupTarget(group);
  const labelRef = useRef(/** @type {HTMLAnchorElement | null} */ (null));
  const { open, handlers } = useHoverIntent({ returnFocusRef: labelRef });
  const { trackRef, indicatorRef, registerItem } = useSlidingIndicator(current?.to ?? null, {
    // Folded away, the puck just sits under the current page; it only
    // springs when you switch sub-pages with the group open.
    animate: open,
  });
  const GroupIcon = group.icon;

  return (
    <div
      data-slot="nav-group"
      data-open={open || undefined}
      {...handlers}
      className={cn(
        "flex items-center rounded-pill",
        "motion-safe:transition-[background-color,color,padding] duration-[var(--motion-duration-short4)]",
        open ? "surface-primary pr-1" : "",
      )}
    >
      <Link
        ref={labelRef}
        to={target}
        aria-current={current && !open ? "page" : undefined}
        aria-keyshortcuts={keyShortcut}
        className={
          open
            ? cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-pill text-secondary",
                "hover:ring-2 hover:ring-accent focus-visible:ring-3 focus-visible:ring-accent",
                "motion-safe:transition-shadow duration-[var(--motion-duration-short4)]",
              )
            : closedClassName
        }
        onClick={() => haptic("selection")}
      >
        <GroupIcon size={ICON_SIZE.lg} aria-hidden="true" />
        <span>{group.label}</span>
      </Link>
      <Unfold open={open}>
        <div className="flex items-center w-max py-1">
          <span className="mx-1.5 h-4 w-0.5 rounded-pill bg-accent" aria-hidden="true" />
          <div ref={trackRef} className="relative flex items-center gap-1">
            <span
              ref={indicatorRef}
              aria-hidden="true"
              className={cn(
                "absolute left-0 top-0 h-full rounded-pill surface-secondary opacity-0",
                "motion-safe:transition-[transform,width,opacity] duration-[var(--motion-duration-medium2)] ease-[var(--motion-easing-spring)]",
              )}
            />
            {group.children.map((child) => (
              <NavLink
                key={child.to}
                to={child.to}
                ref={registerItem(child.to)}
                className={cn(
                  "relative flex items-center gap-1.5 px-3 py-1 rounded-pill text-secondary aria-[current=page]:text-primary",
                  "motion-safe:transition-[color,box-shadow] duration-[var(--motion-duration-short4)]",
                  "hover:ring-2 hover:ring-accent focus-visible:ring-3 focus-visible:ring-accent",
                )}
                onClick={() => haptic("selection")}
              >
                <child.icon size={ICON_SIZE.md} aria-hidden="true" />
                <span>{child.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      </Unfold>
    </div>
  );
}
