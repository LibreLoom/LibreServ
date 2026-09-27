import { Link } from "react-router-dom";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * TextLink — an inline text link that contrasts on both surfaces.
 *
 * Text takes the surface's own text token; the underline carries the accent
 * (accent is for outlines/dividers, never text). Picked from `surface`:
 *   - surface="primary"  (page bg)  → text-secondary
 *   - surface="secondary" (card bg) → text-primary
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
  const text = surface === "secondary" ? "text-primary" : "text-secondary";
  const classes = cn(
    text,
    "underline decoration-accent underline-offset-2 hover:decoration-current motion-safe:transition-colors",
    className,
  );

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