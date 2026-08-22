import { cn } from "../../lib/utils.js";

/** @param {any} props */
export function Separator({ className = "" }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}
