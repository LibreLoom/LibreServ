import { cn } from "../../lib/utils.js";

/** @param {any} props */
export function Input({ className = "", type = "text", ...props }) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-pill border border-input bg-background px-4 py-2 font-mono text-sm text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

/** @param {any} props */
export function Textarea({ className = "", ...props }) {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-lg border border-input bg-background px-4 py-2 font-mono text-sm text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
