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
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** @param {any} props */
export function Badge({ className = "", variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** @param {{ status: string }} props */
export function StatusBadge({ status }) {
  const map = {
    active: "success",
    trialing: "success",
    none: "outline",
    past_due: "warning",
    canceled: "destructive",
    cancelled: "destructive",
    issued: "warning",
    claimed: "success",
    revoked: "destructive",
    expired: "outline",
  };
  return <Badge variant={map[status] || "default"}>{status}</Badge>;
}

const deviceTokenStatusLabels = {
  unbound: "Unused",
  bound: "Bound",
  revoked: "Revoked",
};

/** @param {{ status: string }} props */
export function DeviceTokenStatusBadge({ status }) {
  const map = {
    unbound: "warning",
    bound: "success",
    revoked: "destructive",
  };
  const label = deviceTokenStatusLabels[status] || status;
  return <Badge variant={map[status] || "default"}>{label}</Badge>;
}

export { badgeVariants };
