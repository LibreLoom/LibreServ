import PropTypes from "prop-types";
import { cn } from "../../lib/utils";
import { iconImageUrl } from "../../lib/iconImage.js";

/**
 * A lucide icon drawn as a background image, for lists that repeat the same
 * icons on every row (see lib/iconImage.js). `color` comes from
 * `useToneColor()` in the parent, once per row instead of once per icon.
 * Without a usable color it draws the normal <svg>.
 *
 * @param {{
 *   icon: any,
 *   size?: number,
 *   color?: string | null,
 *   className?: string,
 * }} props
 */
export default function IconImage({ icon: Icon, size = 16, color = null, className = "" }) {
  const url = iconImageUrl(Icon, color);
  if (!url) return <Icon size={size} className={className || undefined} aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      data-icon-image=""
      className={cn("inline-block shrink-0 bg-no-repeat bg-center", className)}
      style={{ width: size, height: size, backgroundImage: url, backgroundSize: `${size}px ${size}px` }}
    />
  );
}

IconImage.propTypes = {
  icon: PropTypes.elementType.isRequired,
  size: PropTypes.number,
  color: PropTypes.string,
  className: PropTypes.string,
};
