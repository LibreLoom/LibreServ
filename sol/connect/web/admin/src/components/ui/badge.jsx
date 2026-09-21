import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-pill px-3 py-1 text-xs font-mono transition-colors",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        success: "bg-success/20 text-success border border-success/30",
        warning: "bg-warning/20 text-warning border border-warning/30",
        destructive: "bg-error/20 text-error border border-error/30",
        outline: "border border-border text-foreground",
        info: "bg-info/20 text-info border border-info/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/** @param {any} props */
export function Badge({ className = "", variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** @param {{ status: string }} props */
export function StatusBadge({ status }) {
  const map = {
    active: "success", connected: "success", disabled: "default",
    unavailable: "destructive", cancelled: "destructive", open: "info",
    paid: "success", draft: "default", pending: "warning",
    granted: "success", denied: "destructive", expired: "default",
    healthy: "success", unhealthy: "destructive", inactive: "destructive",
    unused: "warning", revoked: "default",
  };
  return <Badge variant={map[status] || "default"}>{status}</Badge>;
}

export { badgeVariants };
