import { cn } from "../../lib/utils.js";

/** @param {any} props */
export function Label({ className = "", ...props }) {
  return (
    <label
      className={cn("block font-mono text-sm font-medium leading-none text-foreground mb-1.5", className)}
      {...props}
    />
  );
}
