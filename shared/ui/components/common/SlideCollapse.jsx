import { useEffect, useRef, useState } from "react";

/** Matches the width transition below, with slack for a missed transitionend. */
export const SLIDE_COLLAPSE_MS = 300;

/**
 * SlideCollapse — an item that grows in and shrinks out, so its neighbours
 * glide instead of jumping when it appears or goes away. By default it
 * animates width inside a flex row; with `axis="y"` it animates height inside
 * a flex column (use `flex flex-col gap-*` on the parent, not `space-y-*`).
 *
 * While `show` flips to false the last children stay mounted until the exit
 * finishes. `gap` must match the parent's flex gap; the negative margin hides
 * the gap that the collapsed item would otherwise still claim.
 *
 * @param {{ show: boolean, gap?: string, axis?: "x" | "y", children?: import("react").ReactNode }} props
 */
export default function SlideCollapse({ show, gap = "0.5rem", axis = "x", children }) {
  const [mounted, setMounted] = useState(show);
  const [open, setOpen] = useState(false);
  const lastChildren = useRef(children);
  if (show) lastChildren.current = children;

  // Hold the item mounted through its exit, then drop it.
  useEffect(() => {
    if (show) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
    const timer = setTimeout(() => setMounted(false), SLIDE_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [show]);

  if (!mounted) return null;

  const vertical = axis === "y";
  const size = open ? "1fr" : "0fr";

  return (
    <div
      className={
        vertical
          ? "grid motion-safe:transition-[grid-template-rows,margin,opacity] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]"
          : "grid shrink-0 motion-safe:transition-[grid-template-columns,margin,opacity] motion-safe:duration-300 motion-safe:ease-out"
      }
      style={
        vertical
          ? { gridTemplateRows: size, marginTop: open ? 0 : `-${gap}`, opacity: open ? 1 : 0 }
          : { gridTemplateColumns: size, marginLeft: open ? 0 : `-${gap}`, opacity: open ? 1 : 0 }
      }
      inert={open ? undefined : true}
    >
      <div className={vertical ? "min-h-0 overflow-hidden" : "min-w-0 overflow-hidden"}>
        {lastChildren.current}
      </div>
    </div>
  );
}
