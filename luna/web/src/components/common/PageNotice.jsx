import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Card from "../cards/Card";

/**
 * PageNotice — short status or error copy on a page, always card-wrapped.
 */
export default function PageNotice({ variant = "info", children, className = "" }) {
  const tone =
    variant === "error"
      ? "border-error/30 bg-error/20 text-error"
      : variant === "warning"
        ? "border-warning/30 bg-warning/20 text-primary"
        : "border-accent/30 bg-accent/10 text-primary";
  return (
    <Card className={cn("border", tone, className)} data-slot="page-notice">
      <div className="text-sm" role="status">
        {typeof children === "string" ? <p>{children}</p> : children}
      </div>
    </Card>
  );
}

PageNotice.propTypes = {
  variant: PropTypes.oneOf(["info", "error", "warning"]),
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
};
