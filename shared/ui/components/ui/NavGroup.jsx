import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { cn } from "../../lib/utils.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { haptic } from "../../utils/haptics.js";
import { activeChild, useGroupTarget } from "../../hooks/useNavGroup.js";

/** @typedef {import("../../hooks/useNavGroup").NavGroupItem} NavGroupItem */

// Same overshoot spring as the mobile menu button.
const SPRING = "ease-[cubic-bezier(0.34,1.56,0.64,1)]";

// Hover intent: a mouse sweeping across the bar shouldn't fan Files open,
// and a brief slip off the pill shouldn't snap it shut.
const PEEK_OPEN_MS = 120;
const PEEK_CLOSE_MS = 220;

/**
 * Desktop: a normal nav pill — shown as selected while you are on one of its
 * sub-pages — that unfolds its sub-pages in place only while you hover or
 * focus it, with a puck that springs to whichever sub-page is open.
 *
 * @param {{ group: NavGroupItem, closedClassName: string, keyShortcut?: string }} props
 */
export function DesktopNavGroup({ group, closedClassName, keyShortcut }) {
  const { pathname } = useLocation();
  const current = activeChild(group, pathname);
  const target = useGroupTarget(group);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
  const open = peek;
  const trackRef = useRef(null);
  const puckRef = useRef(null);
  const linkRefs = useRef(/** @type {Record<string, HTMLAnchorElement | null>} */ ({}));
  const hadCurrentRef = useRef(false);
  const labelRef = useRef(/** @type {HTMLAnchorElement | null} */ (null));

  const schedulePeek = (next, delay) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(next), delay);
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  // The puck is positioned straight on the DOM: measuring and moving it is
  // layout work, not React state, and it must not re-render the navbar.
  useLayoutEffect(() => {
    const puck = puckRef.current;
    const track = trackRef.current;
    if (!puck || !track) return undefined;

    const place = (instant) => {
      const link = current ? linkRefs.current[current.to] : null;
      if (!link) {
        puck.style.opacity = "0";
        return;
      }
      if (instant) puck.style.transition = "none";
      puck.style.width = `${link.offsetWidth}px`;
      puck.style.transform = `translateX(${link.offsetLeft}px)`;
      puck.style.opacity = "1";
      if (instant) {
        // Commit the jump before re-enabling the spring.
        void puck.offsetWidth;
        puck.style.transition = "";
      }
    };

    // The puck springs only when you switch sub-pages with the group open;
    // otherwise it is already in place as the pill unfolds around it.
    place(!hadCurrentRef.current || !open);
    hadCurrentRef.current = Boolean(current);

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => place(true));
    observer.observe(track);
    return () => observer.disconnect();
  }, [current, open]);

  const GroupIcon = group.icon;

  return (
    <div
      data-slot="nav-group"
      data-open={open || undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") schedulePeek(true, PEEK_OPEN_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") schedulePeek(false, PEEK_CLOSE_MS);
      }}
      onFocus={(e) => {
        if (!e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget))) schedulePeek(true, 0);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget))) schedulePeek(false, 0);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && peek) {
          clearTimeout(peekTimer.current);
          setPeek(false);
          // The sub-page links go inert; keep focus on the group's own link.
          labelRef.current?.focus();
        }
      }}
      className={cn(
        "flex items-center rounded-pill motion-safe:transition-[background-color,color,padding] duration-300",
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
            ? "flex items-center gap-2 px-3 py-1.5 rounded-pill text-secondary hover:ring-2 hover:ring-accent focus-visible:ring-3 focus-visible:ring-accent motion-safe:transition-shadow duration-200"
            : closedClassName
        }
        onClick={() => haptic("selection")}
      >
        <GroupIcon size={ICON_SIZE.lg} aria-hidden="true" />
        <span>{group.label}</span>
      </Link>
      <div
        className={cn(
          "grid motion-safe:transition-[grid-template-columns] duration-500 ease-[var(--motion-easing-standard)]",
          open ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
        )}
      >
        <div className="min-w-0 overflow-hidden" inert={!open}>
          <div className="flex items-center w-max py-1">
            <span className="mx-1.5 h-4 w-0.5 rounded-pill bg-accent" aria-hidden="true" />
            <div ref={trackRef} className="relative flex items-center gap-1">
              <span
                ref={puckRef}
                aria-hidden="true"
                className={cn(
                  "absolute left-0 top-0 h-full rounded-pill surface-secondary opacity-0",
                  "motion-safe:transition-[transform,width,opacity] duration-500",
                  SPRING,
                )}
              />
              {group.children.map((child) => (
                <NavLink
                  key={child.to}
                  to={child.to}
                  ref={(el) => {
                    linkRefs.current[child.to] = el;
                  }}
                  className={cn(
                    "relative flex items-center gap-1.5 px-3 py-1 rounded-pill text-secondary",
                    "aria-[current=page]:text-primary motion-safe:transition-[color,box-shadow] duration-300",
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
        </div>
      </div>
    </div>
  );
}

/**
 * Mobile menu: the group's name as a mono heading, its sub-pages indented on
 * an accent rail beneath it — every sub-page stays one tap away.
 *
 * @param {{ group: NavGroupItem, itemClassName: string, onNavigate: () => void }} props
 */
export function MobileNavGroup({ group, itemClassName, onNavigate }) {
  const headingId = useId();
  const GroupIcon = group.icon;
  return (
    <div role="group" aria-labelledby={headingId} data-slot="nav-group">
      <p
        id={headingId}
        className="flex items-center gap-2 px-5 pt-2.5 pb-1 font-mono text-[13px]"
      >
        <GroupIcon size={ICON_SIZE.md} aria-hidden="true" />
        {group.label}
      </p>
      <div className="ml-7 pl-2 border-l-2 border-accent flex flex-col gap-1">
        {group.children.map((child) => (
          <NavLink
            key={child.to}
            to={child.to}
            className={cn(itemClassName, "px-4 py-2.5")}
            onClick={() => {
              haptic("selection");
              onNavigate();
            }}
          >
            <child.icon size={ICON_SIZE.lg} aria-hidden="true" />
            <span>{child.label}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
