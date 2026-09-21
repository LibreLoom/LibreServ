import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom theme radii (`rounded-pill`, `rounded-large-element`, …) are not in
 * tailwind-merge's default conflict set. Without this, both classes survive
 * `cn("rounded-pill", "rounded-large-element")` and the pill (9999px) keeps
 * winning visually — Card.jsx already worked around that; RemoteAccessLink
 * stacked cards hit the same bug.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      rounded: [{ rounded: ["pill", "large-element", "button", "card"] }],
    },
  },
});

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
