import PropTypes from "prop-types";
import { Lock } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";

/**
 * Small lock next to a protected item: `label` says whether it is itself a
 * private folder ("Private folder") or an ordinary item inside one ("In a
 * private folder"). It inherits the text color of the surface it sits on.
 *
 * @param {{ size?: number, className?: string, label?: string }} props
 */
export default function PrivateBadge({ size = 14, className = "", label = "Private" }) {
  return (
    <Lock
      size={size}
      role="img"
      aria-label={label}
      data-slot="private-badge"
      className={cn("shrink-0", className)}
    />
  );
}

PrivateBadge.propTypes = {
  size: PropTypes.number,
  className: PropTypes.string,
  label: PropTypes.string,
};
