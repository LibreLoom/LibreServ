import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom theme radii (`rounded-pill`, `rounded-large-element`, …) are not in
 * tailwind-merge's default conflict set. Without this, both classes survive
 * `cn("rounded-pill", "rounded-large-element")` and the pill (9999px) keeps
 * winning visually — Card.jsx already worked around that; RemoteAccessLink
 * stacked cards hit the same bug.
 */
// Cast: tailwind-merge only types its default group ids; "surface" is ours.
const twMerge = extendTailwindMerge(/** @type {any} */ ({
  extend: {
    classGroups: {
      rounded: [{ rounded: ["pill", "large-element", "button", "card"] }],
      // `surface-*` (index.css) sets background and text together. A later
      // surface replaces an earlier one or an earlier bg/text color; a later
      // single bg/text utility keeps the surface and overrides that property.
      surface: [{ surface: ["primary", "secondary"] }],
    },
    conflictingClassGroups: {
      surface: ["bg-color", "text-color"],
    },
  },
}));

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
