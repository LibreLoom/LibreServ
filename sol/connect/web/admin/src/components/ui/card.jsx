import { cn } from "../../lib/utils.js";

/** @param {any} props */
export function Card({ className = "", ...props }) {
  return <div className={cn("rounded-lg border border-border bg-card text-card-foreground p-6", className)} {...props} />;
}

/** @param {any} props */
export function CardHeader({ className = "", ...props }) {
  return <div className={cn("flex flex-col space-y-1.5 pb-4", className)} {...props} />;
}

/** @param {any} props */
export function CardTitle({ className = "", ...props }) {
  return <h3 className={cn("font-mono text-lg leading-none tracking-tight", className)} {...props} />;
}

/** @param {any} props */
export function CardDescription({ className = "", ...props }) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** @param {any} props */
export function CardContent({ className = "", ...props }) {
  return <div className={cn("", className)} {...props} />;
}

/** @param {any} props */
export function CardFooter({ className = "", ...props }) {
  return <div className={cn("flex items-center pt-4", className)} {...props} />;
}
