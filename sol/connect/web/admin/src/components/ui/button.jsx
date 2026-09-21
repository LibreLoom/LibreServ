import { cva } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-mono transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-80",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-80",
        outline: "border border-border text-foreground hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:opacity-80",
        ghost: "text-foreground hover:bg-accent",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded-pill px-3 text-sm",
        md: "h-10 rounded-pill px-5",
        lg: "h-12 rounded-pill px-6 text-lg",
        icon: "h-10 w-10 rounded-pill",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

/** @param {any} props */
export function Button({ className = "", variant, size, asChild = false, loading = false, disabled = false, children, ...props }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={loading || disabled}
      {...props}
    >
      {loading ? "Loading…" : children}
    </Comp>
  );
}

export { buttonVariants };
