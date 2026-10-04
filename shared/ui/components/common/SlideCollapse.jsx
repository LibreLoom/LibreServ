import { useEffect, useRef, useState } from "react";

/** Matches the width transition below, with slack for a missed transitionend. */
export const SLIDE_COLLAPSE_MS = 300;

/**
 * SlideCollapse — a flex-row item that grows in and shrinks out horizontally,
 * so its neighbours glide instead of jumping when it appears or goes away.
 *
 * While `show` flips to false the last children stay mounted until the exit
 * finishes. `gap` must match the parent's flex gap; the negative margin hides
 * the gap that the collapsed item would otherwise still claim.
 *
 * @param {{ show: boolean, gap?: string, children?: import("react").ReactNode }} props
 */
export default function SlideCollapse({ show, gap = "0.5rem", children }) {
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

  return (
    <div
      className="grid shrink-0 motion-safe:transition-[grid-template-columns,margin,opacity] motion-safe:duration-300 motion-safe:ease-out"
      style={{
        gridTemplateColumns: open ? "1fr" : "0fr",
        marginLeft: open ? 0 : `-${gap}`,
        opacity: open ? 1 : 0,
      }}
      inert={open ? undefined : true}
    >
      <div className="min-w-0 overflow-hidden">{lastChildren.current}</div>
    </div>
  );
}
