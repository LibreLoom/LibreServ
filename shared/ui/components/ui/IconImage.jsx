import PropTypes from "prop-types";
import { cn } from "../../lib/utils";
import { iconImageUrl } from "../../lib/iconImage.js";

/**
 * The icon's element, without a component of its own. A long folder mounts one
 * per action button; a component each added a fiber (and, under React
 * DevTools, a logged render) per icon on the folder's opening frame (W4).
 * Function components are not created for plain elements, so this keeps the
 * same DOM while the row stays cheap. Call it from render, never outside it.
 *
 * @param {any} Icon
 * @param {{ size?: number, color?: string | null, className?: string }} [options]
 */
export function iconImageElement(Icon, { size = 16, color = null, className = "" } = {}) {
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
  return iconImageElement(Icon, { size, color, className });
}

IconImage.propTypes = {
  icon: PropTypes.elementType.isRequired,
  size: PropTypes.number,
  color: PropTypes.string,
  className: PropTypes.string,
};
