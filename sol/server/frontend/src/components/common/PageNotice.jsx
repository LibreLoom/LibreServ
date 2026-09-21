import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Card from "../cards/Card";

/**
 * @typedef {object} PageNoticeProps
 * @property {"info"|"error"|"warning"} [variant]
 * @property {import('react').ReactNode} children
 * @property {string} [className]
 * @property {"primary"|"secondary"} [surface]
 */

/**
 * PageNotice — short status or error copy on a page, always card-wrapped.
 * @param {PageNoticeProps} props
 */
export default function PageNotice({
  variant = "info",
  children,
  className = "",
  surface = "primary",
}) {
  const tone =
    variant === "error"
      ? "border-error/30 bg-error/20 text-error"
      : variant === "warning"
        ? surface === "secondary"
          ? "border-warning/30 bg-warning/20 text-primary"
          : "border-warning/30 bg-warning/20 text-secondary"
        : surface === "secondary"
          ? "border-accent/30 bg-accent/10 text-primary"
          : "border-accent/30 bg-accent/10 text-secondary";
  return (
    <Card surface={surface} className={cn("border", tone, className)} data-slot="page-notice">
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
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
