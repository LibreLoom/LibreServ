import { cn } from "../../lib/utils";
import PropTypes from "prop-types";
import Card from "../cards/Card";

/**
 * @typedef {object} PageNoticeProps
 * @property {"info"|"error"|"warning"} [variant]
 * @property {import('react').ReactNode} children
 * @property {string} [className]
 * @property {"primary"|"secondary"} [surface]
 */

// The status tint is a background *image* over the Card's opaque surface, so
// the notice is its own surface: its text color (the surface's) reads on it
// wherever the notice lands. A translucent background would take on whatever
// sits behind it, and status-colored text (red, yellow) is weak on light
// surfaces.
const TONES = {
  error: "border-error/50 bg-linear-to-r from-error/20 to-error/20",
  warning: "border-warning/50 bg-linear-to-r from-warning/20 to-warning/20",
  info: "border-accent/30",
};

/**
 * PageNotice — short status or error copy on a page, always card-wrapped.
 * `surface` picks the notice's own surface; either one reads anywhere.
 * @param {PageNoticeProps} props
 */
export default function PageNotice({
  variant = "info",
  children,
  className = "",
  surface = "primary",
}) {
  return (
    <Card
      surface={surface}
      className={cn("border", TONES[variant] || TONES.info, className)}
      data-slot="page-notice"
    >
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
