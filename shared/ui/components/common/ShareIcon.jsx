import { createLucideIcon } from "lucide-react";

/**
 * Three dots joined by lines, the usual share mark. Lucide's own `Share2`
 * draws hollow r=3 circles whose gaps swallow the lines at 16px, so this
 * one uses smaller solid dots and lines that run centre to centre.
 */
const ShareIcon = createLucideIcon("share-nodes", [
  ["path", { d: "M18 5 6 12l12 7", key: "lines" }],
  ["circle", { cx: "18", cy: "5", r: "2", fill: "currentColor", key: "a" }],
  ["circle", { cx: "6", cy: "12", r: "2", fill: "currentColor", key: "b" }],
  ["circle", { cx: "18", cy: "19", r: "2", fill: "currentColor", key: "c" }],
]);

export default ShareIcon;
