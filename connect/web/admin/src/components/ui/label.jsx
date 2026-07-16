import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils.js";

/** @param {any} props */
export function Label({ className = "", ...props }) {
  return (
    <LabelPrimitive.Root
      className={cn("block font-mono text-sm font-medium leading-none text-foreground mb-1.5", className)}
      {...props}
    />
  );
}
