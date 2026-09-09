import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics.js";

/**
 * TextLink — an inline text link that contrasts on both surfaces.
 *
 * The recurring bug: links use `text-accent hover:text-primary` (invisible on
 * hover on a `bg-primary` page) or `hover:text-secondary` (invisible on hover
 * on a `bg-secondary` card). This component picks the correct hover token from
 * the `surface` it sits on:
 *   - surface="primary"  (page bg)  → hover:text-secondary
 *   - surface="secondary" (card bg) → hover:text-primary
 *
 * Use `to` for router links and `href` for external/anchor links.
 *
 * @param {object} props
 * @param {string} [props.to]   React Router destination.
 * @param {string} [props.href] External/anchor destination.
 * @param {"primary"|"secondary"} [props.surface] Surface the link sits on. Default "primary".
 * @param {string} [props.className]
 * @param {import("react").ReactNode} [props.children]
 * @param {object} [props.state]   Router state for the destination (passed straight to Link).
 * @param {boolean} [props.draggable]
 * @param {(e: React.MouseEvent) => void} [props.onClick]
 * @param {object} [props.rest]
 */
export default function TextLink({
  to,
  href,
  surface = "primary",
  className = "",
  children,
  onClick,
  ...rest
}) {
  const hoverText = surface === "secondary" ? "hover:text-primary" : "hover:text-secondary";
  const classes = cn("text-accent", hoverText, "motion-safe:transition-colors", className);

  const handleClick = (e) => {
    haptic("light");
    onClick?.(e);
  };

  if (to) {
    return (
      <Link to={to} className={classes} onClick={handleClick} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}