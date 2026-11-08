import PropTypes from "prop-types";
import { AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { ICON_SIZE } from "../../lib/ui-tokens";

/**
 * A plain-language error beside the thing that failed: a red icon carries the
 * tone, the words stay the surface's own text color. This is the form-level
 * error shape — a tinted card draws attention away from the field and reads
 * as a page-wide problem when only one answer was refused.
 *
 * Use it inside a form or dialog. For a page-level problem that needs its own
 * heading or a retry action, use PageNotice.
 *
 * @param {{
 *   children: import("react").ReactNode,
 *   id?: string,
 *   className?: string,
 * }} props
 */
export default function InlineError({ children, id, className = "" }) {
  return (
    <p
      id={id}
      role="alert"
      className={cn("flex items-start gap-2 text-sm text-primary", className)}
    >
      <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

InlineError.propTypes = {
  children: PropTypes.node.isRequired,
  id: PropTypes.string,
  className: PropTypes.string,
};
