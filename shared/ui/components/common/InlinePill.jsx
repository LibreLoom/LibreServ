import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

/**
 * InlinePill — a name, value, or literal quoted inside running copy.
 *
 * Use it whenever a sentence or label mentions a real thing — a drive name,
 * file name, path, domain, IP, port, username, token, or option name — so the
 * mention reads as a deliberate chip, not a stray font change. Never set a
 * bare `font-mono` span inside sans copy for this.
 *
 * The fill and border tint from `currentColor`, so it works on any surface
 * (page, card, inverted button) with no surface prop. `text-[0.85em]` keeps
 * the chip from outgrowing the line it sits in.
 *
 * @param {object} props
 * @param {import("react").ReactNode} props.children
 * @param {string} [props.className]
 */
export default function InlinePill({ children, className = "" }) {
  return (
    <span
      data-slot="inline-pill"
      className={cn(
        "inline rounded-pill border border-current/25 bg-current/10 px-1.5 py-0 font-mono text-[0.85em] leading-normal box-decoration-clone",
        className,
      )}
    >
      {children}
    </span>
  );
}

InlinePill.propTypes = {
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
};
